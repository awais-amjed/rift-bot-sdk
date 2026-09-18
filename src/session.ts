import { deriveServerIdentity, signSiws, type ServerIdentity } from './crypto.ts';
import { deriveChatIdentity, type ChatIdentity } from './sealed.ts';
import { parseInvite } from './invite.ts';

/** Anything the server refused. */
export class BotError extends Error {
  /**
   * The HTTP status, when there was one.
   *
   * Here because the polling loop has to tell two failures apart that used to
   * look identical: a session that expired an hour after it was minted, which
   * is recovered by signing again and is nobody's business, and a request the
   * server refused on its merits — a bot with no media key for a call, a
   * command it may not send. Treating the second as the first meant logging in
   * and carrying on in silence, so a bot that could not do the thing it was
   * asked reported nothing at all and looked like a bot nobody had asked.
   */
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.status = status;
  }
}

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
  #anonKey: string;
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

  /**
   * The JWT this session signs its requests with, or null before the first
   * {@link login}. For a listener that has to carry the same one, and be
   * given the next: see `RealtimeListener.setToken`.
   */
  get token(): string | null {
    return this.#token;
  }

  /** The anon key this session reads tables with. Save it — see {@link join}. */
  get anonKey(): string {
    return this.#anonKey;
  }

  /**
   * What a bot needs to come back as itself, minus the seed.
   *
   * Persist this next to the seed after a first {@link join}. The invite is
   * spent once and cannot be replayed, which is the point of an invite.
   */
  get config(): { url: string; anonKey: string; serverId: string } {
    return { url: this.url, anonKey: this.#anonKey, serverId: this.serverId };
  }

  /**
   * Claim an invite and come back a member. The first run, and only the first.
   *
   * BOTS.md §1: a bot is added by invite, the same as a person, because an
   * invite already carries exactly the right thing — a per-server grant of
   * scoped permissions, revocable by whoever minted it. This is what makes that
   * one paste rather than an expedition: the admin sends the same link they
   * would send a person, and everything else is derived or handed back.
   *
   * The order is forced and worth stating. The identity is scoped to
   * `(host, serverId)`, so the invite has to be resolved *before* the keypair
   * exists; the SIWS login creates the auth identity that `register` then binds
   * a profile to. Getting it the other way round derives a keypair for a server
   * you turn out not to be joining.
   *
   * Save {@link config} afterwards and construct a [BotSession] directly on
   * every later run: an invite is spent, and a second `join` with the same one
   * fails as it should.
   */
  static async join(options: {
    /** The invite link, in any of its three shapes. */
    invite: string;
    /** 32 random bytes, kept out of the repo. Whoever holds it *is* the bot. */
    seed: Buffer;
    username: string;
    displayName?: string;
  }): Promise<BotSession> {
    const invite = parseInvite(options.invite);
    if (!invite) {
      throw new BotError(
        `Not an invite: ${options.invite}. Expected "<server-url>#<code>", or ` +
          'the rift:// or https:// form of the same thing.',
      );
    }

    // The server id first — the identity is scoped to it.
    const resolved = await callUnauthenticated(invite.serverUrl, 'resolve_invite', {
      invite_code: invite.inviteCode,
    });
    const serverId = resolved.server_id as string;

    // A session with no anon key: `login` and `register` are edge functions and
    // need none. Nothing touches a table until `register` hands one back.
    const session = new BotSession(invite.serverUrl, '', serverId, options.seed);
    await session.login();

    const context = await session.callFunction('register', {
      invite_code: invite.inviteCode,
      public_key: session.identity.publicKey.toString('base64'),
      stable_id: session.identity.stableId,
      username: options.username,
      display_name: options.displayName ?? options.username,
    });

    const anonKey = context.supabase_key as string | undefined;
    if (!anonKey) {
      throw new BotError('register returned no anon key, so no table is readable');
    }
    session.#anonKey = anonKey;
    // `register` issues no token — the one from `login` is already the caller's
    // — but the profile row now exists, and the claims a policy reads come from
    // a fresh one.
    await session.login();
    return session;
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

  /**
   * Call a database function.
   *
   * Distinct from {@link callFunction}, which reaches an edge function: this
   * one is PostgREST, so the permission check happens inside the database and
   * this bot's JWT is what it is made against.
   */
  async rpc<T = unknown>(name: string, params: Record<string, unknown>): Promise<T> {
    const res = await fetch(`${this.url}/rest/v1/rpc/${name}`, {
      method: 'POST',
      headers: this.#headers(),
      body: JSON.stringify(params),
    });
    await this.#throwIfFailed(res);
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  async patch(query: string, body: Record<string, unknown>): Promise<void> {
    const res = await fetch(`${this.url}/rest/v1/${query}`, {
      method: 'PATCH',
      headers: { ...this.#headers(), Prefer: 'return=minimal' },
      body: JSON.stringify(body),
    });
    await this.#throwIfFailed(res);
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
      throw new BotError(`${name} failed: ${json.error ?? res.status}`, res.status);
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
    throw new BotError(`${res.status}: ${await res.text()}`, res.status);
  }
}

/** The `sub` claim — this bot's user id, which `users.id` is. */
function subjectOf(token: string): string {
  const payload = token.split('.')[1];
  return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')).sub;
}

/**
 * POST to an edge function with no session at all.
 *
 * `resolve_invite` runs before the caller is anybody — it is what hands out the
 * server id the identity is scoped to — so there is nothing to authenticate
 * with yet, and deliberately nothing it grants: you already hold the code.
 */
async function callUnauthenticated(
  url: string,
  name: string,
  body: unknown,
): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}/functions/v1/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json()) as Record<string, unknown>;
  if (json.success !== true) {
    throw new BotError(`${name} failed: ${json.error ?? res.status}`);
  }
  return json.data as Record<string, unknown>;
}
