/**
 * Listening to a Rift server's Realtime, in as little code as that takes.
 *
 * A bot used to ask the server for new messages every two seconds — its own,
 * its DMs, and one query per channel it watched. The database announces all of
 * it now (self-hosted migrations 017 and 018), addressed to the bot's own
 * topic, `user:<bot id>`, which nobody else may join.
 *
 * Realtime speaks Phoenix's protocol over a WebSocket: join a topic, hold it
 * open with a heartbeat, and read the frames that come back. That is short
 * enough to write out, and writing it out is what keeps this package
 * dependency-free — `WebSocket` is built into Node 22, which the package
 * already requires.
 *
 * What arrives is a nudge, never the message: the payload is ids, and the bot
 * reads the row it names through the same queries and the same policies as
 * before. A dropped frame therefore costs latency and nothing else, which is
 * why {@link Bot} keeps a slow poll behind this.
 */

/** One broadcast: what happened, and the ids it happened to. */
export interface RealtimeEvent {
  event: string;
  payload: Record<string, unknown>;
}

const HEARTBEAT_MS = 25_000;

/** `WebSocket.OPEN`, without needing the class to read it. */
const OPEN = 1;

/** Backoff between reconnects: quick at first, then out of the way. */
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000];

/**
 * Keep a timer from holding the process open on its own.
 *
 * Listening is not by itself a reason for a program to stay alive — the bot's
 * own loop is — and a heartbeat that counted would keep a finished script, or
 * a test run, alive for as long as the socket lasted.
 */
function unref<T>(timer: T): T {
  (timer as { unref?: () => void }).unref?.();
  return timer;
}

/** As much of a WebSocket as this uses — the shape a test can stand in for. */
export interface Socketish {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
}

export interface RealtimeOptions {
  /** The server's URL, as the session holds it (`https://…`). */
  url: string;
  /** The server's publishable key. */
  anonKey: string;
  /** The bot's JWT. Replaceable while connected — see {@link setToken}. */
  token: string;
  /** The topic to join, without Phoenix's `realtime:` prefix. */
  topic: string;
  onEvent: (event: RealtimeEvent) => void;
  /** Told about a connection that failed or was refused. Never fatal. */
  onError?: (error: Error) => void;
  /** How to open the socket. Node's own `WebSocket` unless a test says else. */
  connect?: (url: string) => Socketish;
}

/**
 * A single joined topic, kept open.
 *
 * Reconnects on its own, forever: a bot whose connection dropped at three in
 * the morning should be listening again at three-oh-one, not at the next
 * deploy. {@link stop} is the only thing that ends it.
 */
export class RealtimeListener {
  readonly #options: RealtimeOptions;
  #socket: Socketish | null = null;
  #heartbeat: ReturnType<typeof setInterval> | null = null;
  #retry: ReturnType<typeof setTimeout> | null = null;
  #attempt = 0;
  #ref = 0;
  #token: string;
  #stopped = false;

  constructor(options: RealtimeOptions) {
    this.#options = options;
    this.#token = options.token;
  }

  /** Whether the topic is joined right now. */
  get connected(): boolean {
    return this.#socket?.readyState === OPEN;
  }

  start(): void {
    this.#stopped = false;
    this.#open();
  }

  stop(): void {
    this.#stopped = true;
    this.#clearTimers();
    this.#socket?.close();
    this.#socket = null;
  }

  /**
   * Carry on with a new JWT.
   *
   * A bot's token expires within the hour and it signs in again; the server
   * closes a topic whose token has run out, so the new one has to reach it.
   */
  setToken(token: string): void {
    this.#token = token;
    if (!this.connected) return;
    this.#send({
      topic: this.#phoenixTopic,
      event: 'access_token',
      payload: { access_token: token },
      ref: String(++this.#ref),
    });
  }

  get #phoenixTopic(): string {
    return `realtime:${this.#options.topic}`;
  }

  #open(): void {
    if (this.#stopped) return;
    const base = this.#options.url.replace(/^http/, 'ws');
    const url =
      `${base}/realtime/v1/websocket` +
      `?apikey=${encodeURIComponent(this.#options.anonKey)}&vsn=1.0.0`;

    let socket: Socketish;
    try {
      socket = (this.#options.connect ?? ((at: string) => new WebSocket(at)))(url);
    } catch (error) {
      this.#failed(error);
      return;
    }
    this.#socket = socket;

    socket.addEventListener('open', () => {
      this.#attempt = 0;
      // The topic is private, so the join carries the token the server checks
      // `app.can_use_topic` with. Without `private` it would join a different,
      // public topic of the same name and hear nothing.
      this.#send({
        topic: this.#phoenixTopic,
        event: 'phx_join',
        payload: {
          config: { broadcast: { self: false }, private: true },
          access_token: this.#token,
        },
        ref: String(++this.#ref),
      });
      this.#heartbeat = unref(
        setInterval(() => {
          this.#send({
            topic: 'phoenix',
            event: 'heartbeat',
            payload: {},
            ref: String(++this.#ref),
          });
        }, HEARTBEAT_MS),
      );
    });

    socket.addEventListener('message', (frame) => this.#received(frame.data));
    socket.addEventListener('error', () => {});
    socket.addEventListener('close', () => this.#failed(null));
  }

  #received(data: unknown): void {
    if (typeof data !== 'string') return;
    let frame: {
      event?: string;
      payload?: Record<string, unknown>;
      topic?: string;
    };
    try {
      frame = JSON.parse(data);
    } catch {
      return;
    }
    if (frame.topic !== this.#phoenixTopic) return;

    if (frame.event === 'broadcast') {
      const payload = frame.payload ?? {};
      const event = payload.event;
      const body = payload.payload;
      if (typeof event !== 'string') return;
      this.#options.onEvent({
        event,
        payload: (body ?? {}) as Record<string, unknown>,
      });
      return;
    }

    // A refused join answers here rather than closing the socket — the topic
    // is simply never joined, which otherwise looks like a quiet server.
    if (frame.event === 'phx_reply') {
      const payload = frame.payload ?? {};
      if (payload.status === 'error') {
        const response = payload.response;
        const reason =
          response && typeof response === 'object' && 'reason' in response
            ? String((response as { reason: unknown }).reason)
            : 'refused';
        this.#report(new Error(`realtime: ${this.#options.topic}: ${reason}`));
      }
    }
  }

  #send(message: Record<string, unknown>): void {
    try {
      this.#socket?.send(JSON.stringify(message));
    } catch (error) {
      this.#report(error);
    }
  }

  #failed(error: unknown): void {
    this.#clearTimers();
    this.#socket = null;
    if (error) this.#report(error);
    if (this.#stopped) return;
    const wait = RETRY_MS[Math.min(this.#attempt, RETRY_MS.length - 1)];
    this.#attempt++;
    this.#retry = unref(setTimeout(() => this.#open(), wait));
  }

  #clearTimers(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat);
    if (this.#retry) clearTimeout(this.#retry);
    this.#heartbeat = null;
    this.#retry = null;
  }

  #report(error: unknown): void {
    this.#options.onError?.(
      error instanceof Error ? error : new Error(String(error)),
    );
  }
}
