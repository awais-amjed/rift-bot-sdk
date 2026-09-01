import { deriveServerIdentity, signSiws, type ServerIdentity } from './crypto.ts';
import { deriveChatIdentity, type ChatIdentity } from './sealed.ts';

/** Anything the server refused. */
export class BotError extends Error {}

/**
 * A bot's connection to one self-hosted Rift server.
 *
 * There is no bot API to speak of, which is the point: a bot authenticates the
 * way a person does, over the same `login` function, and is subject to the same
 * row-level security. A capability the app has a bot has, and neither can drift
 * away from the other.
 *
 * The seed is the whole identity — 32 random bytes, kept out of the repo, and
 * whoever holds it *is* the bot. Nothing but signatures ever reaches the server.
 */
export class BotSession {
  readonly url: string;
  readonly serverId: string;
  readonly identity: ServerIdentity;

  /** The X25519 identity members seal things to.
   *
   *  A bot has one for exactly one reason — its media key in an encrypted call
   *  (BOTS.md §6b) — and it is derived here rather than from a stored seed so
   *  the seed itself does not have to live on this object. */
  readonly chatIdentity: ChatIdentity;

  // Fields declared rather than written as constructor parameter properties:
  // Node runs this file by *stripping* types, and a parameter property is the
  // one piece of TypeScript that has to generate code rather than erase it. The
  // whole package is buildless, and that is worth more than four lines.
  readonly #anonKey: string;
  #token: string | null = null;
  #userId: string | null = null;

  constructor(url: string, anonKey: string, serverId: string, seed: Buffer) {
    this.url = url;
    this.#anonKey = anonKey;
    this.serverId = serverId;
    this.identity = deriveServerIdentity(seed, new URL(url).hostname, serverId);
    // Per host, not per server, and pinned at v1 — see WIRE.md §2.
    this.chatIdentity = deriveChatIdentity(seed, new URL(url).hostname);
  }

  /**
   * Publish this bot's chat public key so members can seal things to it.
   *
   * Idempotent and cheap. Without it a bot is invisible to the sealing loop:
   * `get_channel_key` only lists bots that have published one, so a bot that
   * skipped this would wait forever for a media key nobody can produce.
   */
  publishChatKey(): Promise<void> {
    return this.patch(`users?id=eq.${this.#userId}`, {
      chat_public_key: this.chatIdentity.publicKey.toString('base64'),
    });
  }

  /** This bot's user id on this server. Null until the first {@link login}. */
  get userId(): string | null {
    return this.#userId;
  }

  /**
   * Sign in, or refresh a session that has expired.
   *
   * Cheap enough to call before anything: the key comes from the seed, so there
   * is no prompt, no stored refresh token to lose, and no state to recover if
   * the process restarts. A bot that crashes comes back as itself.
   */
  async login(): Promise<void> {
    const signed = signSiws(this.identity);
    const data = await this.callFunction('login', {
      message: signed.message,
      signature: signed.signature,
    });
    this.#token = data.access_token as string;
    this.#userId = subjectOf(this.#token);
  }

  /** Publish what this bot answers to, and what it does with what it is given. */
  publishManifest(manifest: Record<string, unknown>): Promise<void> {
    return this.patch(`users?id=eq.${this.#userId}`, { manifest });
  }

  async select<T = Record<string, unknown>>(query: string): Promise<T[]> {
    const res = await fetch(`${this.url}/rest/v1/${query}`, { headers: this.#headers() });
    await this.#throwIfFailed(res);
    return (await res.json()) as T[];
  }

  async insert(table: string, row: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.url}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...this.#headers(), Prefer: 'return=minimal' },
      body: JSON.stringify(row),
    });
    await this.#throwIfFailed(res);
  }

  /** An insert that hands the row back — needed only where the id matters. */
  async insertReturning<T = Record<string, unknown>>(
    table: string,
    row: Record<string, unknown>,
  ): Promise<T[]> {
    const res = await fetch(`${this.url}/rest/v1/${table}`, {
      method: 'POST',
      headers: { ...this.#headers(), Prefer: 'return=representation' },
      body: JSON.stringify(row),
    });
    await this.#throwIfFailed(res);
    return (await res.json()) as T[];
  }

  async patch(query: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.url}/rest/v1/${query}`, {
      method: 'PATCH',
      headers: { ...this.#headers(), Prefer: 'return=minimal' },
      body: JSON.stringify(body),
    });
    await this.#throwIfFailed(res);
  }

  /**
   * Tell anyone with the channel open that something happened.
   *
   * `new_message` makes a client fetch what is *newer* than it has. A panel
   * being redrawn is not newer than anything, so an edit rings `message_changed`
   * with the row's id instead — ringing the wrong one leaves the panel showing
   * the state it had when the channel was opened, which for the one feature
   * whose point is changing in place is the failure that looks like it working.
   *
   * Best-effort, and never allowed to fail what it announces: the row is
   * already written, every client re-reads on open, and a bot that threw
   * because a doorbell did not ring would retry and answer twice.
   */
  async ringDoorbell(
    channelId: string,
    event = 'new_message',
    payload: Record<string, unknown> = {},
  ): Promise<void> {
    try {
      await fetch(`${this.url}/realtime/v1/api/broadcast`, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify({
          messages: [{ topic: `chat:${channelId}`, event, payload }],
        }),
      });
    } catch {
      // Deliberately swallowed. See above.
    }
  }

  async callFunction(name: string, body: unknown): Promise<Record<string, unknown>> {
    const res = await fetch(`${this.url}/functions/v1/${name}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(this.#token ? { Authorization: `Bearer ${this.#token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (json.success !== true) {
      throw new BotError(`${name} failed: ${json.error ?? res.status}`);
    }
    return json.data as Record<string, unknown>;
  }

  #headers(): Record<string, string> {
    return {
      apikey: this.#anonKey,
      Authorization: `Bearer ${this.#token}`,
      'Content-Type': 'application/json',
    };
  }

  async #throwIfFailed(res: Response): Promise<void> {
    if (res.ok) return;
    throw new BotError(`${res.status}: ${await res.text()}`);
  }
}

/** The `sub` claim — this bot's user id, which `users.id` is. */
function subjectOf(token: string): string {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).sub;
}
