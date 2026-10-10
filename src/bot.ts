import { createHash, randomBytes } from 'node:crypto';

import { signedPayload, sign } from './crypto.ts';
import { imageInfo } from './image.ts';
import { BotError, type BotSession } from './session.ts';
import { joinVoice, type VoiceConnection, type VoiceOptions } from './voice.ts';
import { DirectMessages, type DirectMessage } from './dm.ts';
import { RealtimeListener } from './realtime.ts';
import { ChannelReader, type ChannelMessage } from './channel.ts';
import {
  parseSuggestRequest,
  suggestionsPayload,
  SUGGEST_EVENT,
  SUGGESTIONS_EVENT,
  type Suggestion,
  type SuggestRequest,
} from './suggest.ts';

/** One command, or one press, as the bot receives it. */
export interface BotMessage {
  readonly id: number;
  readonly channelId: string;
  readonly senderId: string;
  /** The whole line typed, slash included — the SDK does not split arguments,
   *  because only the bot knows what its arguments mean. */
  readonly text: string;
  /** Set when this is a press on a panel: the button's own action id. */
  readonly actionId?: string;
  /** The chosen option's value, for a menu. Absent for a button. */
  readonly actionValue?: string;
  /** The panel that was pressed, for editing it back. */
  readonly panelId?: number;
}

/** Whether somebody pressed something rather than typed something. */
export function isAction(message: BotMessage): boolean {
  return message.actionId !== undefined;
}

/** The verb, lower-cased and without the slash — `/Play a song` → `play`. */
export function command(message: BotMessage): string {
  const body = message.text.trim();
  if (!body.startsWith('/')) return '';
  const end = body.search(/\s/);
  return (end === -1 ? body.slice(1) : body.slice(1, end)).toLowerCase();
}

/** Everything after the verb, trimmed. Empty for a bare command. */
export function args(message: BotMessage): string {
  const body = message.text.trim();
  const end = body.search(/\s/);
  return end === -1 ? '' : body.slice(end).trim();
}

/** One block of a panel. See `WIRE.md` §5 for the vocabulary. */
export type PanelBlock = Record<string, unknown>;

export interface PanelOptions {
  /**
   * A member's user id: only they see the panel. Check a press on it came from
   * them all the same — nothing stops another member naming a panel id they
   * cannot see.
   */
  readonly onlyFor?: string;
}

/**
 * A running bot: poll for what it is addressed, answer it.
 *
 * **It only ever sees what it was addressed.** That is not this class being
 * careful — `messages_select` will not return anything else, so a bug here
 * cannot widen it, and neither can a bug in your bot. What the class saves you
 * is the same two queries and the same signature every time.
 */
export class Bot {
  readonly session: BotSession;

  /// How often the backstop poll runs. Not the way messages normally arrive —
  /// see [listen] — which is why it is half a minute rather than two seconds.
  readonly pollMs: number;

  /// Null when [listen] was told not to use Realtime.
  #realtime: RealtimeListener | null = null;
  readonly #useRealtime: boolean;

  /// Set while a drain is queued from a broadcast, so a burst of them — a
  /// message, its reaction, an edit — costs one pass rather than one each.
  #queued: ReturnType<typeof setTimeout> | null = null;

  #lastSeen = 0;
  #lastDm = 0;
  #timer: NodeJS.Timeout | null = null;

  /// Direct messages, which are the one thing a bot both opens and seals. See
  /// [DirectMessages] — they are held apart from channel replies because the
  /// two have different reach, and mixing up which one an answer went to is the
  /// mistake worth making impossible.
  readonly dms: DirectMessages;

  /// One tick at a time. `setInterval` does not wait for the previous callback,
  /// so a slow handler — or a slow network — lets two ticks run the same query
  /// before either advances `#lastSeen`, and the same message is delivered
  /// twice. For a bot that echoes, that is a duplicate; for one that awards a
  /// point or plays a track, it is a wrong answer. Found by pressing a button
  /// once and watching a poll go up by two.
  #draining = false;

  #onDirectMessage: ((message: DirectMessage) => void | Promise<void>) | null = null;

  #onError: ((error: BotError) => void) | null = null;

  #onSuggest: ((request: SuggestRequest) => Suggestion[] | Promise<Suggestion[]>) | null = null;

  /// Per asker: whether a suggestion is being worked out, and the newest
  /// request that came in meanwhile. Someone typing fast sends one per pause;
  /// only the last is worth answering, and answering each in turn would land
  /// a stale menu after the right one.
  readonly #suggesting = new Map<string, SuggestRequest | null>();

  /// Channels this bot was granted and is reading, by id, each with its own
  /// cursor. A cursor per channel rather than one shared: they advance
  /// independently, and one channel stalled on an unsealed rotation must not
  /// hold up another.
  readonly #watched = new Map<
    string,
    {
      reader: ChannelReader;
      lastSeen: number;
      handler: (message: ChannelMessage) => void | Promise<void>;
    }
  >();

  /**
   * [pollMs] is the backstop, not the delivery: with Realtime on, a message
   * arrives when the database announces it, and the poll is what catches
   * anything a dropped frame lost. Pass `{ realtime: false }` to go back to
   * polling alone, and then a short [pollMs] is what you want again.
   */
  constructor(session: BotSession, pollMs = 30_000, options: { realtime?: boolean } = {}) {
    this.session = session;
    this.pollMs = pollMs;
    this.#useRealtime = options.realtime ?? true;
    this.dms = new DirectMessages(session);
  }

  /**
   * Answer direct messages too.
   *
   * Call before {@link listen}. A DM to a bot is private from the *server* as
   * well as from every member (BOTS.md §3) — it is sealed to the two of you and
   * nothing else can read it, which is exactly why it is the one place a bot
   * does real chat crypto rather than writing plaintext.
   */
  onDirectMessage(handler: (message: DirectMessage) => void | Promise<void>): void {
    this.#onDirectMessage = handler;
  }

  /**
   * Read a channel this bot has been **granted** — BOTS.md §6, the one place a
   * bot sees what it was not addressed.
   *
   * Call before {@link listen}. Returns the grant's `from_key_version`, or
   * **null when this bot was never granted this channel** — which is worth
   * checking, because an ungranted bot polls forever and receives nothing, and
   * that looks exactly like a quiet channel. Nothing here can widen the grant:
   * `messages_select` decides, so a bug in your handler cannot read a word more
   * than an admin allowed.
   *
   * Reading starts from *now*, like {@link listen}. Scrollback before the grant
   * is not readable at all — the keys for it were never sealed to this bot.
   */
  async watchChannel(
    channelId: string,
    handler: (message: ChannelMessage) => void | Promise<void>,
  ): Promise<number | null> {
    // Called *before* `listen`, which is where the login normally happens — so
    // without this the grant lookup runs as nobody: `session.userId` is null,
    // the query asks for `bot_id=eq.null`, and the request carries
    // `Bearer null`. That came back 401 and threw out of a method documented to
    // answer "were you granted this?", so `example/watch_bot.ts` could not run
    // at all. Logging in is cheap, idempotent and derives from the seed.
    if (this.session.userId === null) await this.session.login();

    const reader = new ChannelReader(this.session, channelId);
    const grantedFrom = await reader.grantedFrom();
    if (grantedFrom === null) return null;
    this.#watched.set(channelId, {
      reader,
      lastSeen: await reader.newestId(),
      handler,
    });
    return grantedFrom;
  }

  /**
   * Offer suggestions while somebody types one of this bot's commands —
   * the rows Rift shows above the composer for `/play thats so tr`.
   *
   * Only for a command the manifest marks `suggest: true`; Rift asks for no
   * other. Return up to ten `{label, value}`: the label is the row, and picking
   * it sends `/<command> <value>`, which then arrives through {@link listen}
   * like anything typed.
   *
   * **Look things up; do nothing.** Who asked is the asking client's claim
   * (WIRE.md §7), so a handler that queued a song or changed a setting would
   * do it for anybody who said they were somebody. Needs Realtime, so not with
   * `{ realtime: false }`. Call before {@link listen}.
   */
  onSuggest(handler: (request: SuggestRequest) => Suggestion[] | Promise<Suggestion[]>): void {
    this.#onSuggest = handler;
  }

  #suggest(payload: Record<string, unknown>): void {
    const request = parseSuggestRequest(payload);
    if (!request || !this.#onSuggest) return;
    if (this.#suggesting.has(request.from)) {
      this.#suggesting.set(request.from, request);
      return;
    }
    this.#suggesting.set(request.from, null);
    void this.#answer(request);
  }

  async #answer(request: SuggestRequest): Promise<void> {
    try {
      const items = await this.#onSuggest!(request);
      await this.session.broadcast(
        `user:${request.from}`,
        SUGGESTIONS_EVENT,
        suggestionsPayload(request, this.session.userId ?? '', items),
      );
    } catch (error) {
      this.#reportError(new BotError(`suggestions for /${request.command}: ${(error as Error).message}`));
    } finally {
      const next = this.#suggesting.get(request.from);
      if (next) {
        this.#suggesting.set(request.from, null);
        void this.#answer(next);
      } else {
        this.#suggesting.delete(request.from);
      }
    }
  }

  /**
   * Hear about a tick that failed on its merits — not an expired session, which
   * is recovered silently and is nobody's business.
   *
   * Without a handler these go to `console.error`, because the alternative is
   * what this replaced: nothing at all.
   */
  onError(handler: (error: BotError) => void): void {
    this.#onError = handler;
  }

  #reportError(error: BotError): void {
    if (this.#onError) {
      this.#onError(error);
      return;
    }
    console.error(`[rift] ${error.message}`);
  }

  /**
   * Start answering. Called once per message, in id order.
   *
   * Starts from *now*: a bot restarting does not replay a backlog of commands
   * people gave up on minutes ago and act on all of them at once.
   *
   * The database announces what this bot may hear on its own topic,
   * and this listens there: a message addressed to it, a button
   * press, a DM, and anything written in a channel it has been granted. What
   * arrives is ids, so every read still goes through the same queries and the
   * same policies — a broadcast cannot widen what a bot sees.
   *
   * The poll stays behind it, slowly. A broadcast is best-effort by design,
   * and a bot that missed one and waited for the next would have stopped
   * working without saying so.
   */
  async listen(onMessage: (message: BotMessage) => void | Promise<void>): Promise<void> {
    await this.session.login();
    // So members can seal this bot things — today that means its media key for
    // an encrypted call. Idempotent, and a bot that skipped it would simply
    // never appear in the sealing loop.
    await this.session.publishChatKey();
    this.#lastSeen = await this.#newestId();
    if (this.#onDirectMessage) this.#lastDm = await this.dms.newestId();
    this.#timer = setInterval(() => void this.#drain(onMessage), this.pollMs);
    if (this.#useRealtime) this.#startRealtime(onMessage);
  }

  /**
   * Sign in again after the session expired, and hand the new token to the
   * realtime socket.
   *
   * The polling loop does this itself when one of its reads comes back 401.
   * Call it when one of *your* calls does — a panel redraw an hour into a
   * song — and retry the call. Logging in through `session.login()` alone would
   * leave the socket on the old token: the server closes a topic whose token
   * runs out, and the bot drops back to polling without a word.
   */
  async renewSession(): Promise<void> {
    await this.session.login();
    this.#realtime?.setToken(this.session.token ?? '');
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#queued) clearTimeout(this.#queued);
    this.#queued = null;
    this.#realtime?.stop();
    this.#realtime = null;
  }

  /** Whether the bot is hearing the server rather than asking it. */
  get listening(): boolean {
    return this.#realtime?.connected ?? false;
  }

  #startRealtime(onMessage: (message: BotMessage) => void | Promise<void>): void {
    const userId = this.session.userId;
    if (userId === null) return;
    this.#realtime = new RealtimeListener({
      url: this.session.url,
      anonKey: this.session.anonKey,
      token: this.session.token ?? '',
      topic: `user:${userId}`,
      // Every event here means "something you can read has changed", and one
      // drain answers all of them: the cursors decide what is actually new.
      // ...apart from a request for suggestions, which carries what it asks
      // and reads nothing.
      onEvent: (event) =>
        event.event === SUGGEST_EVENT ? this.#suggest(event.payload) : this.#soon(onMessage),
      onError: (error) => this.#reportError(new BotError(error.message)),
    });
    this.#realtime.start();
  }

  /** Coalesce a burst of announcements into one pass, a tick from now. */
  #soon(onMessage: (message: BotMessage) => void | Promise<void>): void {
    if (this.#queued) return;
    this.#queued = setTimeout(() => {
      this.#queued = null;
      void this.#drain(onMessage);
    }, 50);
  }

  /** Answer in the channel, where everybody can see it. */
  reply(to: BotMessage, text: string): Promise<void> {
    return this.#post(to, text, null);
  }

  /**
   * Answer only the person who asked.
   *
   * Genuinely private from the *channel* — `messages_select` enforces it, so no
   * member ever receives the row — and not from the server, which stores it
   * unencrypted like everything else a bot touches.
   */
  replyPrivately(to: BotMessage, text: string): Promise<void> {
    return this.#post(to, text, to.senderId);
  }

  /**
   * Say something in a channel that nobody asked for.
   *
   * The shape a watching bot needs: it noticed something rather than being
   * addressed, so there is no message to reply to. In the clear like everything
   * else a bot writes — signed but not sealed — so a member can always tell
   * which half of the room a line came from, even in a channel this bot can
   * read.
   *
   * Posting still needs `can_see_channel`, which a grant does not give: a bot
   * granted a *private* channel can read it and cannot speak in it. Getting in
   * far enough to speak is a role with `channel_role_access`, the same door a
   * `/` command comes through.
   */
  async post(channelId: string, text: string): Promise<void> {
    await this.session.insert('messages', {
      channel_id: channelId,
      ...this.#envelope(channelId, text),
    });
  }

  /**
   * Post a panel, and return its id.
   *
   * Hold on to it. A queue that posts a new panel per track is the log a panel
   * exists to replace.
   *
   * With [options.onlyFor], one member sees it and nobody else: a choice that
   * is theirs to make, like which of five search results they meant. Private
   * from the channel the way {@link replyPrivately} is, and no further.
   */
  async panel(channelId: string, blocks: PanelBlock[], options: PanelOptions = {}): Promise<number | null> {
    // Signed over the empty body, not over the blocks: the signature attests
    // *who wrote the row*, and the panel is structure the client validates
    // itself. Signing a JSON encoding would make that encoding part of the
    // signature, and then a whitespace change would break every panel.
    const envelope = this.#envelope(channelId, '');
    const rows = await this.session.insertReturning<{ id: number }>('messages', {
      channel_id: channelId,
      ...envelope,
      blocks: { v: 1, blocks },
      ...(options.onlyFor ? { ephemeral_for: options.onlyFor } : {}),
    });
    return rows.length === 0 ? null : rows[0].id;
  }

  /**
   * Take a panel away. Only the bot that posted it may.
   *
   * For a panel whose job is done — a choice made, a prompt nobody answered —
   * where redrawing it to say so would leave a row behind for nothing.
   */
  async deletePanel(panelId: number): Promise<void> {
    await this.session.remove(`messages?id=eq.${panelId}`);
  }

  /**
   * Store a picture for a panel in [channelId], and get the block that shows it.
   *
   * The picture goes to this server's own attachment bucket, under the channel
   * — never a URL, because a URL would make every member's client fetch from
   * wherever it pointed (BOTS.md §5). Only members who can see the channel can
   * read it, and the client draws it only in a panel in that same channel.
   *
   * **It is stored unencrypted**, like the panel itself: the server can see it.
   * PNG, JPEG, WebP or GIF; its size is read from the header so the panel holds
   * room for it. Needs `ATTACH_FILES`, which `@everyone` has unless a server
   * took it away, and counts against the server's storage like any upload.
   *
   * Every call stores a new file. When a panel moves on to another picture,
   * {@link deleteImage} the old one, or a music bot leaves one cover per track
   * behind until the channel's own history is swept.
   */
  async uploadImage(
    channelId: string,
    bytes: Uint8Array,
    options: { alt?: string } = {},
  ): Promise<PanelBlock & { path: string }> {
    const info = imageInfo(bytes);
    if (!info) throw new BotError('uploadImage: not a PNG, JPEG, WebP or GIF');
    const path = `${channelId}/${randomBytes(16).toString('hex')}.${info.extension}`;
    await this.session.uploadObject(this.#bucket, path, bytes, info.contentType);
    return {
      type: 'image',
      path,
      sha256: createHash('sha256').update(bytes).digest('base64'),
      ...(info.width ? { width: info.width, height: info.height } : {}),
      ...(options.alt ? { text: options.alt } : {}),
    };
  }

  /** Delete a picture {@link uploadImage} stored, by the block's `path`. */
  async deleteImage(path: string): Promise<void> {
    await this.session.removeObject(this.#bucket, path);
  }

  /** The server's attachment bucket: one per server, `chat-<server id>`. */
  get #bucket(): string {
    return `chat-${this.session.serverId}`;
  }

  /**
   * The voice channels this bot has been summoned to, newest first.
   *
   * How a bot answers `/play` with somewhere to go. It cannot see a voice
   * channel it was not asked into — a summon is permission to publish there,
   * not membership — so this row is the only way it learns the id.
   *
   * A member's client writes one when they send a command the bot's manifest
   * marked `voice: true`, so the usual shape is: take the command, read this,
   * `joinVoice` the newest one. Empty means nobody has asked, which for a
   * command that needs a call is worth saying rather than failing silently.
   */
  async summons(): Promise<{ channelId: string; summonedBy: string | null }[]> {
    const rows = await this.session.select<{
      channel_id: string;
      summoned_by: string | null;
    }>(
      `bot_voice_summons?select=channel_id,summoned_by&bot_id=eq.${this.session.userId}` +
        '&order=summoned_at.desc',
    );
    return rows.map((r) => ({
      channelId: r.channel_id,
      summonedBy: r.summoned_by,
    }));
  }

  /**
   * Leave, and give back the welcome.
   *
   * Dropping the summon drops the media key with it, so a bot that stops
   * playing stops being able to arrive. Worth calling rather than just
   * disconnecting: the row is what members see as "this is in the call", and
   * one left behind is a bot that looks present and is not.
   */
  async dismissSelf(channelId: string): Promise<void> {
    await this.session.rpc('dismiss_bot_from_voice', {
      p_bot: this.session.userId,
      p_channel: channelId,
    });
  }

  /**
   * Join a voice channel, and get something to publish audio through.
   *
   * **The bot publishes; it does not hear.** Its token is minted with
   * `canSubscribe: false` unless an admin granted it listening on this channel
   * — check {@link VoiceConnection.canHear} rather than wondering why no audio
   * arrives. A music bot is unaffected: playing is the half that never needed
   * a grant.
   *
   * Needs `@livekit/rtc-node`, which is an optional dependency and is imported
   * only by this call. A text bot never loads a WebRTC stack.
   */
  joinVoice(channelId: string, options?: VoiceOptions): Promise<VoiceConnection> {
    return joinVoice(this.session, channelId, options);
  }

  /**
   * Redraw a panel in place. Only the bot that posted it may.
   *
   * [channelId] is no longer used for anything and is kept so calls do not
   * have to change: the database announces the edit itself, to everyone who
   * may see the channel it is in.
   */
  async editPanel(channelId: string, panelId: number, blocks: PanelBlock[]): Promise<void> {
    void channelId;
    await this.session.patch(`messages?id=eq.${panelId}`, { blocks: { v: 1, blocks } });
  }

  async #drain(onMessage: (message: BotMessage) => void | Promise<void>): Promise<void> {
    if (this.#draining) return;
    this.#draining = true;
    try {
      const rows = await this.session.select<Record<string, unknown>>(
        'messages?select=id,channel_id,sender_id,ciphertext,action_id,action_value,reply_to' +
          `&to_bot=eq.${this.session.userId}&id=gt.${this.#lastSeen}&order=id.asc`,
      );
      for (const row of rows) {
        this.#lastSeen = row.id as number;
        await onMessage({
          id: row.id as number,
          channelId: row.channel_id as string,
          senderId: row.sender_id as string,
          text: (row.ciphertext as string) ?? '',
          actionId: (row.action_id as string) ?? undefined,
          actionValue: (row.action_value as string) ?? undefined,
          panelId: (row.reply_to as number) ?? undefined,
        });
      }

      // The same tick, not a second timer: one cursor per source, but one
      // drain, so a slow handler cannot let the two overlap each other.
      const handler = this.#onDirectMessage;
      if (handler) {
        for (const dm of await this.dms.since(this.#lastDm)) {
          this.#lastDm = dm.id;
          await handler(dm);
        }
      }

      for (const watch of this.#watched.values()) {
        // Advanced by what came back, not by the newest row on the server:
        // `since` stops at a message whose key has not been sealed for this bot
        // yet, and jumping the cursor past it would drop that stretch of the
        // conversation for good. Standing still is the recoverable failure.
        for (const message of await watch.reader.since(watch.lastSeen)) {
          watch.lastSeen = message.id;
          await watch.handler(message);
        }
      }
    } catch (error) {
      if (!(error instanceof BotError)) throw error;

      // A session expires an hour after it is minted, and the only recovery is
      // the one that needs no state: sign again with the key the seed derives.
      // Swallowing *that* tick is right — the next one retries, and the
      // commands are still in the database waiting.
      //
      // 401 and nothing else. Not 403, which is RLS refusing on the merits and
      // will refuse again after a fresh login; and **not** a `BotError` with no
      // status, which is this SDK's own — "no media key for this channel yet"
      // is the one a summoned bot hits, and sending it round the login path is
      // how it stayed invisible.
      if (error.status === 401) {
        await this.renewSession();
        return;
      }

      // Everything else is a refusal worth hearing about. It used to go down
      // the same path, so the bot logged in again and carried on in silence —
      // and a bot that could not do the thing it was asked looked exactly like
      // a bot nobody had asked. Found by summoning one into an empty call.
      this.#reportError(error);
    } finally {
      this.#draining = false;
    }
  }

  async #newestId(): Promise<number> {
    const rows = await this.session.select<{ id: number }>(
      `messages?select=id&to_bot=eq.${this.session.userId}&order=id.desc&limit=1`,
    );
    return rows.length === 0 ? 0 : rows[0].id;
  }

  /**
   * Signed but not sealed, which is the whole shape of a bot's message.
   *
   * Not sealed: a bot holds no channel key and never will, so a sealed reply is
   * one its readers would have to open with a key it could not have used.
   * Signed: the reply carries the bot's name in a room full of people, and
   * clients drop what they cannot verify — an unsigned reply is an invisible
   * one.
   */
  #envelope(channelId: string, text: string): Record<string, unknown> {
    return {
      ciphertext: text,
      nonce: '',
      key_version: 0,
      signature: sign(signedPayload(channelId, 0, '', text), this.session.identity.privateKey),
    };
  }

  async #post(to: BotMessage, text: string, ephemeralFor: string | null): Promise<void> {
    await this.session.insert('messages', {
      channel_id: to.channelId,
      ...this.#envelope(to.channelId, text),
      reply_to: to.id,
      ...(ephemeralFor ? { ephemeral_for: ephemeralFor } : {}),
    });
  }
}
