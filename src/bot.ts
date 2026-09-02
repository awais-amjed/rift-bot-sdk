import { signedPayload, sign } from './crypto.ts';
import { BotError, type BotSession } from './session.ts';
import { joinVoice, type VoiceConnection, type VoiceOptions } from './voice.ts';
import { DirectMessages, type DirectMessage } from './dm.ts';
import { ChannelReader, type ChannelMessage } from './channel.ts';

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
  readonly pollMs: number;

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

  constructor(session: BotSession, pollMs = 2000) {
    this.session = session;
    this.pollMs = pollMs;
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
   * Start answering. Called once per message, in id order.
   *
   * Starts from *now*: a bot restarting does not replay a backlog of commands
   * people gave up on minutes ago and act on all of them at once.
   *
   * Polling rather than Realtime, deliberately, for the first version: no
   * reconnect logic to get wrong, and nothing spent from the server's shared
   * event budget (~100/second, which every member's unread badges draw on too).
   * Replies and panel redraws still ring the doorbell, so an answer appears at
   * once for anyone with the channel open.
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
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
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
    await this.session.ringDoorbell(channelId);
  }

  /**
   * Post a panel, and return its id.
   *
   * Hold on to it. A queue that posts a new panel per track is the log a panel
   * exists to replace.
   */
  async panel(channelId: string, blocks: PanelBlock[]): Promise<number | null> {
    // Signed over the empty body, not over the blocks: the signature attests
    // *who wrote the row*, and the panel is structure the client validates
    // itself. Signing a JSON encoding would make that encoding part of the
    // signature, and then a whitespace change would break every panel.
    const envelope = this.#envelope(channelId, '');
    const rows = await this.session.insertReturning<{ id: number }>('messages', {
      channel_id: channelId,
      ...envelope,
      blocks: { v: 1, blocks },
    });
    await this.session.ringDoorbell(channelId);
    return rows.length === 0 ? null : rows[0].id;
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

  /** Redraw a panel in place. Only the bot that posted it may. */
  async editPanel(channelId: string, panelId: number, blocks: PanelBlock[]): Promise<void> {
    await this.session.patch(`messages?id=eq.${panelId}`, { blocks: { v: 1, blocks } });
    await this.session.ringDoorbell(channelId, 'message_changed', {
      message_id: String(panelId),
    });
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
      // Swallowing the tick is right — the next one retries, and the commands
      // are still in the database waiting.
      await this.session.login();
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
    // Without this the reply is stored and nobody with the channel open hears
    // about it until they reopen — which for an answer to a question somebody
    // just asked is the same as not answering.
    await this.session.ringDoorbell(to.channelId);
  }
}
