import { signedPayload, verifySignature } from './crypto.ts';
import { decodeBody } from './dm.ts';
import { unwrapKey } from './sealed.ts';
import type { BotSession } from './session.ts';
import { open, SenderKeys } from './verify.ts';

/**
 * How long to wait before asking the keyring again for a version this bot does
 * not hold. Long enough that an unsealed rotation is not a per-message round
 * trip, short enough that a bot picks up the seal within one human moment of a
 * member opening the channel.
 */
const KEY_REFETCH_MS = 30_000;

/** One channel message, opened. */
export interface ChannelMessage {
  readonly id: number;
  readonly channelId: string;
  readonly senderId: string;
  readonly text: string;
  readonly sentAt: string;
  /** Which key version it was sealed under. Useful for nothing but debugging a
   *  rotation, and the one number this whole feature turns on. */
  readonly keyVersion: number;
}

interface MessageRow {
  id: number;
  channel_id: string;
  sender_id: string | null;
  ciphertext: string;
  nonce: string;
  signature: string | null;
  key_version: number;
  created_at: string;
}

interface KeyRow {
  key_version: number;
  ephemeral_public_key: string;
  ciphertext: string;
  nonce: string;
}

/**
 * Reading a channel the bot has been granted — the one exception in BOTS.md §6.
 *
 * **This is the only thing a bot does that a bot is not supposed to do.**
 * Everywhere else it hears what it is told: a command addressed to it, a press
 * on its own panel, a DM sealed to it. Here it holds the channel key and reads
 * a conversation nobody addressed to it, because a moderation bot cannot work
 * any other way and there is no cryptographic middle ground.
 *
 * Four things make that something you can offer rather than regret, and none of
 * them is enforced here — they are all rows in the database, so a bug in this
 * file cannot widen any of them:
 *
 *   * an admin granted it, per channel, on purpose;
 *   * the grant is **forward-only** — `from_key_version` is one past the
 *     version current when it was made, and `messages_select` reads the same
 *     number the keyring trigger writes against;
 *   * revoking rotates the key *and* stops the reading in the same statement;
 *   * the channel says so, in a message everybody in it can see.
 *
 * What still does not arrive: anything sealed before the grant, anything with
 * `key_version` 0 (webhook posts, system notices, and commands to *other* bots
 * — never sealed, so no grant covers them), somebody else's ephemeral reply,
 * and another bot's button press.
 */
export class ChannelReader {
  readonly session: BotSession;
  readonly channelId: string;

  /** Channel keys by version, unwrapped once. A rotation adds one; none is
   *  ever replaced, because scrollback under the old version stays readable. */
  readonly #keys = new Map<number, Buffer>();
  readonly #senders: SenderKeys;
  /** When the keyring was last fetched, so a missing version is retried on a
   *  budget rather than on every message. */
  #loadedAt = 0;

  constructor(session: BotSession, channelId: string) {
    this.session = session;
    this.channelId = channelId;
    this.#senders = new SenderKeys(session);
  }

  /**
   * The first key version this bot may hold here, or null if it was never
   * granted this channel.
   *
   * Worth calling before {@link listen}: an ungranted bot polling forever
   * receives nothing and has no way to tell that from a quiet channel. This is
   * the difference, and it is one row.
   */
  async grantedFrom(): Promise<number | null> {
    const rows = await this.session.select<{ from_key_version: number }>(
      `bot_channel_keys?select=from_key_version&channel_id=eq.${this.channelId}` +
        `&bot_id=eq.${this.session.userId}`,
    );
    return rows.length === 0 ? null : rows[0].from_key_version;
  }

  /** The newest id here, so a restart does not replay a backlog. */
  async newestId(): Promise<number> {
    const rows = await this.session.select<{ id: number }>(
      `messages?select=id&channel_id=eq.${this.channelId}&order=id.desc&limit=1`,
    );
    return rows.length === 0 ? 0 : rows[0].id;
  }

  /**
   * Everything readable here after [afterId], oldest first.
   *
   * **Stops at the first message whose key has not arrived yet**, rather than
   * skipping it. A rotation is sealed for this bot by the next member to open
   * the channel, so a version can exist for a moment before its key does — and
   * a caller that advanced past those rows would drop exactly the stretch of
   * conversation a moderation bot was granted to see, silently and forever.
   * Coming back to the same id and finding nothing new is the visible failure;
   * quietly moving on is not.
   *
   * A row that is unopenable for any other reason — unsigned, wrongly signed,
   * never sealed — is skipped, because no amount of waiting changes it.
   */
  async since(afterId: number): Promise<ChannelMessage[]> {
    const rows = await this.session.select<MessageRow>(
      'messages?select=id,channel_id,sender_id,ciphertext,nonce,signature,' +
        `key_version,created_at&channel_id=eq.${this.channelId}` +
        `&id=gt.${afterId}&order=id.asc`,
    );

    const out: ChannelMessage[] = [];
    for (const row of rows) {
      if (row.sender_id && row.signature && row.key_version >= 1) {
        if (!(await this.#keyFor(row.key_version))) break;
      }
      const message = await this.#open(row);
      if (message) out.push(message);
    }
    return out;
  }

  /**
   * Open one row, or null if it cannot be trusted or cannot be opened.
   *
   * Both are silent and both are ordinary. A signature that does not check out
   * means the row is not from who it claims, and a bot acting on it is the
   * whole attack. A body that will not decrypt is one sealed under a version
   * this bot was not granted — which the policy already withholds, so reaching
   * this is a rotation landing mid-poll rather than anything wrong.
   */
  async #open(row: MessageRow): Promise<ChannelMessage | null> {
    // A row with no sender is a webhook post or a system notice. Neither is
    // sealed and neither is signed, so there is nothing here to verify against
    // and nothing to open — the policy withholds them anyway.
    if (!row.sender_id || !row.signature || row.key_version < 1) return null;

    try {
      const key = await this.#keyFor(row.key_version);
      if (!key) return null;

      const payload = signedPayload(
        this.channelId,
        row.key_version,
        row.nonce,
        row.ciphertext,
      );
      const senderKey = await this.#senders.publicKeyFor(row.sender_id);
      if (!senderKey || !verifySignature(payload, row.signature, senderKey)) {
        return null;
      }

      return {
        id: row.id,
        channelId: row.channel_id,
        senderId: row.sender_id,
        text: decodeBody(open(row.ciphertext, row.nonce, key)),
        sentAt: row.created_at,
        keyVersion: row.key_version,
      };
    } catch {
      return null;
    }
  }

  /**
   * The channel key for one version.
   *
   * A miss means a rotation this bot has not been sealed into yet, so it
   * refetches — but no more than once every {@link KEY_REFETCH_MS}, or a
   * channel waiting on a member to come online would turn every poll into two
   * round trips forever. It keeps retrying rather than giving up: the seal
   * arrives whenever the next member opens the channel, which may be hours.
   */
  async #keyFor(version: number): Promise<Buffer | null> {
    const cached = this.#keys.get(version);
    if (cached) return cached;
    if (Date.now() - this.#loadedAt < KEY_REFETCH_MS) return null;
    await this.#loadKeys();
    return this.#keys.get(version) ?? null;
  }

  async #loadKeys(): Promise<void> {
    this.#loadedAt = Date.now();
    const rows = await this.session.select<KeyRow>(
      'channel_keyring?select=key_version,ephemeral_public_key,ciphertext,nonce' +
        `&channel_id=eq.${this.channelId}&user_id=eq.${this.session.userId}`,
    );
    for (const row of rows) {
      if (this.#keys.has(row.key_version)) continue;
      try {
        this.#keys.set(row.key_version, unwrapKey(this.session.chatIdentity, row));
      } catch {
        // Sealed to a chat key this bot no longer has. Skipping it leaves that
        // version unreadable rather than taking the whole channel down.
      }
    }
  }
}
