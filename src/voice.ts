import { BotError, type BotSession } from './session.ts';
import { unwrapKey, type Wrapped } from './sealed.ts';
import {
  CHANNELS,
  FRAME_SAMPLES,
  SAMPLE_RATE,
  audioFrames,
} from './audio_frames.ts';

/**
 * A bot in a voice channel.
 *
 * **A bot publishes; it does not hear.** Two things hold that, and only the
 * second is arithmetic. The token is minted with `canSubscribe: false` unless
 * an admin granted listening (migration 031). And the call is end-to-end
 * encrypted, so what a bot can decrypt is decided by which key it was given:
 *
 *     botKey = HMAC-SHA256(channelKey, "voicebot:v1:<botId>")
 *
 * Every member holds `channelKey` and derives `botKey`, so the room hears the
 * bot. The bot is sealed only `botKey`, and HMAC does not run backwards, so it
 * cannot reach `channelKey` — a music bot is audible and deaf at the same time,
 * which one shared room key cannot express (BOTS.md §2, §6b).
 *
 * A member's client seals that key; the bot never derives it and never sees the
 * channel key. Until some member has been in the channel, there is no key and
 * `get_channel_token` says so rather than letting the bot join inaudibly.
 *
 * The media itself is `@livekit/rtc-node`'s, imported here and nowhere else and
 * only when {@link Bot.joinVoice} is called. That is why it is an optional
 * dependency rather than a real one: a bot that answers `/echo` should not
 * install a WebRTC stack it never loads, and most bots are that bot.
 */

/**
 * The ring slot a bot's media always occupies — see the note in `joinVoice`.
 * Members read a bot's key from here rather than from its version's slot.
 */
export const BOT_KEY_INDEX = 0;

/** Just enough of rtc-node's E2EE manager to put a key in the right slot. */
interface RtcE2EEManager {
  keyProvider?: { setSharedKey(key: Uint8Array, keyIndex: number): void };
}

/** The shape of `@livekit/rtc-node` this file uses, so the rest stays typed. */
interface RtcModule {
  Room: new () => RtcRoom;
  AudioSource: new (sampleRate: number, channels: number) => RtcAudioSource;
  LocalAudioTrack: { createAudioTrack(name: string, source: RtcAudioSource): unknown };
  AudioFrame: new (
    data: Int16Array,
    sampleRate: number,
    channels: number,
    samplesPerChannel: number,
  ) => unknown;
  TrackPublishOptions: new () => { source: number };
  TrackSource: { SOURCE_MICROPHONE: number };
}

interface RtcRoom {
  connect(url: string, token: string, options?: unknown): Promise<void>;
  disconnect(): Promise<void>;
  localParticipant?: { publishTrack(track: unknown, options: unknown): Promise<unknown> };
}

interface RtcAudioSource {
  captureFrame(frame: unknown): Promise<void>;
  close?(): Promise<void>;
}


export interface VoiceOptions {
  /**
   * Distinguishes two connections held by the same bot. Identity is
   * `<userId>~<deviceId>`, and a second connection reusing the first's id
   * disconnects it — so a bot playing in two channels at once needs two.
   * Defaults to the channel id, which is unique by construction.
   */
  deviceId?: string;
}

export class VoiceConnection {
  readonly channelId: string;

  /**
   * Whether this bot was granted listening here.
   *
   * Read from the token's own grant rather than from the table, because the
   * token is what LiveKit will actually enforce. Worth surfacing: a
   * transcription bot that was never granted would otherwise sit in the room
   * receiving nothing and look like a bug in its own audio pipeline.
   */
  readonly canHear: boolean;

  readonly #rtc: RtcModule;
  readonly #room: RtcRoom;
  #source: RtcAudioSource | null = null;
  #playing = false;

  /**
   * Which slot in LiveKit's key ring this bot's key occupies.
   *
   * Always {@link BOT_KEY_INDEX}, never `keyVersion % KEY_RING_SIZE` — see the
   * note in {@link joinVoice}. It used to report the version's slot, which is
   * where a *member's* key goes and is not where this one is, so anybody who
   * trusted it was reading a number the frame cryptor disagreed with.
   */
  readonly keyIndex: number;

  constructor(
    channelId: string,
    canHear: boolean,
    rtc: RtcModule,
    room: RtcRoom,
    keyIndex: number,
  ) {
    this.channelId = channelId;
    this.canHear = canHear;
    this.#rtc = rtc;
    this.#room = room;
    this.keyIndex = keyIndex;
  }

  /**
   * Publish signed 16-bit little-endian PCM at 48kHz stereo, and resolve when
   * it runs out.
   *
   * Anything that yields `Buffer`s works — an `ffmpeg` child process's stdout
   * is the usual one, and it is what turns "a URL" into something publishable
   * without this package having an opinion about codecs.
   *
   * The cutting into frames is [audioFrames], which is where the carry between
   * chunks lives.
   */
  async play(pcm: AsyncIterable<Uint8Array>): Promise<void> {
    if (this.#playing) throw new BotError('already playing on this connection');
    this.#playing = true;

    const source = new this.#rtc.AudioSource(SAMPLE_RATE, CHANNELS);
    this.#source = source;

    // Inside the try, not before it: publishing can fail, and when it did the
    // `finally` had not been entered yet, so `#playing` stayed true forever and
    // every later `play()` on this connection threw "already playing" — a bot
    // that lost one track went quiet for good.
    try {
      const track = this.#rtc.LocalAudioTrack.createAudioTrack('audio', source);
      const options = new this.#rtc.TrackPublishOptions();
      options.source = this.#rtc.TrackSource.SOURCE_MICROPHONE;
      await this.#room.localParticipant?.publishTrack(track, options);

      for await (const samples of audioFrames(pcm, () => this.#playing)) {
        await source.captureFrame(
          new this.#rtc.AudioFrame(samples, SAMPLE_RATE, CHANNELS, FRAME_SAMPLES),
        );
      }
    } finally {
      this.#playing = false;
      await source.close?.();
      this.#source = null;
    }
  }

  /** Stop the current {@link play}. The stream is left to whoever owns it. */
  stop(): void {
    this.#playing = false;
  }

  get playing(): boolean {
    return this.#playing;
  }

  /** Leave the call. */
  async leave(): Promise<void> {
    this.stop();
    await this.#source?.close?.();
    await this.#room.disconnect();
  }
}

/**
 * Connect to a channel's room.
 *
 * The token comes from `get_channel_token`, the same edge function the app
 * calls — there is no bot path here either, which is what stops the two
 * drifting. The function decides what the token may do; this only reads it back.
 */
export async function joinVoice(
  session: BotSession,
  channelId: string,
  options: VoiceOptions = {},
): Promise<VoiceConnection> {
  const rtc = await loadRtc();

  // The media key first: without it the bot would connect, publish frames
  // nobody can decrypt, and look like a working bot that everyone has muted.
  const media = await mediaKey(session, channelId);

  const data = await session.callFunction('get_channel_token', {
    channel_id: channelId,
    device_id: options.deviceId ?? channelId,
  });
  const token = data.token as string;

  const room = new rtc.Room();
  await room.connect(await livekitUrl(session), token, {
    autoSubscribe: true,
    e2ee: { keyProviderOptions: { sharedKey: media.key } },
  });

  // Shared-key mode is right for a bot and only for a bot: it publishes with
  // one key and subscribes to nothing it could decrypt anyway. Members run in
  // per-participant mode, which is what lets them hold a different key for the
  // bot than for each other.
  //
  // **A bot always encrypts in slot 0**, whatever version its key is, and that
  // is not a choice — it is what this SDK is able to do. A frame cryptor is
  // created when its track is published and keeps the index it was born with;
  // moving it needs `FrameCryptor.setKeyIndex`, which throws in
  // `@livekit/rtc-node` because the FFI request it builds omits a `track_sid`
  // the native side requires. Trying and failing is worse than not trying: it
  // leaves the bot inaudible with a stack trace instead of a rule.
  //
  // So the rule is the slot, and Rift's clients read a bot's key from 0 for
  // exactly this reason (`livekit_e2ee.dart`). Slot 0 is where `connect` put it
  // via `keyProviderOptions.sharedKey`; this is the same key again, said out
  // loud, so the agreement is written down in both places rather than resting
  // on a default.
  const manager = (room as unknown as { e2eeManager?: RtcE2EEManager }).e2eeManager;
  manager?.keyProvider?.setSharedKey(media.key, BOT_KEY_INDEX);

  return new VoiceConnection(
    channelId,
    grantAllowsSubscribe(token),
    rtc,
    room,
    BOT_KEY_INDEX,
  );
}

/** How long {@link mediaKey} waits for a member to seal one, and how often. */
const MEDIA_KEY_WAIT_MS = 15_000;
const MEDIA_KEY_POLL_MS = 500;

/**
 * The key this bot's media is encrypted with in [channelId], and its ring slot.
 *
 * Sealed by a member and read back here — the bot cannot derive it, which is
 * the point: it is a one-way function of a channel key the bot does not have.
 *
 * **Waited for, not merely asked for.** The summon is what *causes* the
 * sealing: a member's client sees it and seals in response. So the first
 * `/play` into a channel is a race this end always used to lose — measured at
 * 0.7 s between the summon landing and the key appearing, with the bot having
 * asked once in between and given up. That is not an edge case, it is every
 * bot's first summon into every channel.
 *
 * It still gives up, because waiting cannot help when there is nobody there to
 * seal: a channel no member has opened has no key and will not grow one.
 */
async function mediaKey(
  session: BotSession,
  channelId: string,
): Promise<{ key: Buffer; keyVersion: number }> {
  const deadline = Date.now() + MEDIA_KEY_WAIT_MS;
  for (;;) {
    const data = await session.callFunction('get_channel_key', {
      channel_id: channelId,
    });
    const sealed = data.my_voice_key as (Wrapped & { key_version: number }) | null;
    if (sealed) {
      return {
        key: unwrapKey(session.chatIdentity, sealed),
        keyVersion: sealed.key_version,
      };
    }
    if (Date.now() >= deadline) {
      throw new BotError(
        'No media key for this channel after waiting. A member has to be ' +
          'there to seal one — their client is what does it, in answer to the ' +
          'summon, and nobody answered.',
      );
    }
    await new Promise((resolve) => setTimeout(resolve, MEDIA_KEY_POLL_MS));
  }
}

/**
 * Where this server's LiveKit lives.
 *
 * On the server's own `servers` row, which every member can read — the API
 * secret is the part that is hidden, and a bot never needs it because it never
 * mints its own token.
 */
async function livekitUrl(session: BotSession): Promise<string> {
  const rows = await session.select<{ livekit_url: string }>(
    `servers?select=livekit_url&id=eq.${session.serverId}`,
  );
  const url = rows[0]?.livekit_url;
  if (!url) throw new BotError('this server has no LiveKit URL configured');
  return url;
}

/**
 * `video.canSubscribe` out of the LiveKit JWT, which defaults to true.
 *
 * Exported for its test. Unreadable is false, not true: a bot told it can hear
 * when it cannot spends its time debugging its audio pipeline, and one told it
 * cannot when it can is merely pessimistic.
 */
export function grantAllowsSubscribe(token: string): boolean {
  try {
    const payload = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64url').toString('utf8'),
    );
    return payload?.video?.canSubscribe !== false;
  } catch {
    return false;
  }
}

/**
 * `@livekit/rtc-node`, or an error that says what to install.
 *
 * A bare "Cannot find module" from a dynamic import inside a dependency is one
 * of the less helpful things a runtime says, and the fix here is one command.
 */
async function loadRtc(): Promise<RtcModule> {
  try {
    return (await import('@livekit/rtc-node')) as unknown as RtcModule;
  } catch {
    throw new BotError(
      'Voice needs @livekit/rtc-node, which this package does not install by ' +
        'default. Run: npm install @livekit/rtc-node',
    );
  }
}
