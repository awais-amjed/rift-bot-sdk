import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS,
  FRAME_SAMPLES,
  SAMPLE_RATE,
  audioFrames,
} from '../src/audio_frames.ts';
import { VoiceConnection, grantAllowsSubscribe } from '../src/voice.ts';

/// What a bot may hear, and how what it says gets cut up.
///
/// Neither of these needs a WebRTC stack, which is the point of both being
/// reachable without one: the failures they describe are silent. A grant read
/// the wrong way round makes a bot debug an audio pipeline that was never the
/// problem, and a frame boundary off by two bytes is a click you can only hear.

const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;

/** A stream that hands over the chunk sizes a pipe actually hands over. */
async function* chunks(...sizes: number[]) {
  let n = 0;
  for (const size of sizes) {
    const chunk = new Uint8Array(size);
    for (let i = 0; i < size; i++) chunk[i] = n++ & 0xff;
    yield chunk;
  }
}

async function collect(stream: AsyncIterable<Int16Array>): Promise<Int16Array[]> {
  const out: Int16Array[] = [];
  for await (const frame of stream) out.push(frame);
  return out;
}

test('a frame is 10ms of 48kHz stereo', () => {
  // LiveKit's own tick. Larger frames add latency to a skip; smaller ones spend
  // more time crossing the bridge than in the codec.
  assert.equal(SAMPLE_RATE, 48000);
  assert.equal(CHANNELS, 2);
  assert.equal(FRAME_SAMPLES, 480);
  assert.equal(FRAME_BYTES, 1920);
});

test('whole frames come out whole', async () => {
  const frames = await collect(audioFrames(chunks(FRAME_BYTES * 3)));
  assert.equal(frames.length, 3);
  for (const frame of frames) assert.equal(frame.length, FRAME_SAMPLES * CHANNELS);
});

test('a chunk boundary mid-frame carries into the next chunk', async () => {
  // The bug this guards: publishing what is left at the end of a chunk as a
  // short frame. It stores fine, plays, and clicks.
  const frames = await collect(audioFrames(chunks(FRAME_BYTES + 100, FRAME_BYTES - 100)));
  assert.equal(frames.length, 2);
  for (const frame of frames) assert.equal(frame.length, FRAME_SAMPLES * CHANNELS);
});

test('and the samples either side of that boundary are the ones that were sent', async () => {
  // Not just the right *number* of frames — the right bytes, in order. A carry
  // that dropped or repeated its tail would still produce two full frames.
  const [, second] = await collect(audioFrames(chunks(FRAME_BYTES + 2, FRAME_BYTES - 2)));
  const expected = new Uint8Array(FRAME_BYTES);
  for (let i = 0; i < FRAME_BYTES; i++) expected[i] = (FRAME_BYTES + i) & 0xff;
  assert.deepEqual(
    new Uint8Array(second.buffer, second.byteOffset, FRAME_BYTES),
    expected,
  );
});

test('chunks smaller than a frame accumulate rather than each becoming one', async () => {
  const frames = await collect(audioFrames(chunks(...Array(8).fill(FRAME_BYTES / 4))));
  assert.equal(frames.length, 2);
});

test('a trailing partial frame is dropped, not padded', async () => {
  // Under 10ms at the end of a track. Padding it would mean inventing samples.
  const frames = await collect(audioFrames(chunks(FRAME_BYTES + 7)));
  assert.equal(frames.length, 1);
});

test('a frame does not alias the chunk it came from', async () => {
  // The helper above yields `Uint8Array`, whose `slice` copies. A real pipe
  // yields a Node `Buffer`, whose `slice` is an alias of `subarray` and shares
  // memory — so this is the shape that catches it, and the one every caller
  // actually passes. A frame sits in LiveKit's queue long after the chunk it
  // came from has been reused, and an aliased frame plays whatever landed
  // there next.
  const chunk = Buffer.alloc(FRAME_BYTES);
  chunk.fill(0x11);

  async function* one() {
    yield chunk;
  }
  const [frame] = await collect(audioFrames(one()));

  chunk.fill(0x77);
  assert.equal(frame[0], 0x1111, 'the frame changed when the chunk was reused');
});

test('an unaligned buffer is still cut into frames', async () => {
  // `new Int16Array(ab, byteOffset, …)` throws outright when the offset is odd,
  // and a Buffer handed out of Node's pool carries whatever offset the pool
  // had. Failing here would be an exception mid-track rather than a click.
  const backing = Buffer.alloc(FRAME_BYTES * 2 + 1);
  const odd = backing.subarray(1, 1 + FRAME_BYTES * 2);
  assert.equal(odd.byteOffset % 2, 1, 'the fixture must actually be misaligned');

  async function* one() {
    yield odd;
  }
  assert.equal((await collect(audioFrames(one()))).length, 2);
});

test('stopping ends the stream at the next chunk', async () => {
  let going = true;
  const stream = audioFrames(chunks(FRAME_BYTES, FRAME_BYTES, FRAME_BYTES), () => going);
  const out: Int16Array[] = [];
  for await (const frame of stream) {
    out.push(frame);
    going = false;
  }
  assert.equal(out.length, 1);
});

/** A LiveKit token with the given video grant, unsigned — only the claims are read. */
function tokenWith(video: unknown): string {
  const part = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${part({ alg: 'HS256' })}.${part({ video })}.signature`;
}

test('a bot with no grant is told it cannot hear', () => {
  assert.equal(grantAllowsSubscribe(tokenWith({ canPublish: true, canSubscribe: false })), false);
});

test('a granted bot is told it can', () => {
  assert.equal(grantAllowsSubscribe(tokenWith({ canPublish: true, canSubscribe: true })), true);
});

test('an absent flag means yes, which is what LiveKit does', () => {
  assert.equal(grantAllowsSubscribe(tokenWith({ canPublish: true })), true);
});

test('a token that cannot be read means no', () => {
  // Pessimism is the safe direction: it reports less than the bot has, never
  // more, and "cannot hear" is the answer that sends somebody to the admin
  // rather than into their own audio code.
  assert.equal(grantAllowsSubscribe('not a jwt'), false);
});

/** A room that can be ended from outside, the way the server ends one. */
class FakeRoom {
  #onDisconnected: (() => void) | null = null;
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {
    this.end();
  }
  once(_event: 'disconnected', listener: () => void): void {
    this.#onDisconnected = listener;
  }
  end(): void {
    const listener = this.#onDisconnected;
    this.#onDisconnected = null;
    listener?.();
  }
}

function connectionIn(room: FakeRoom): VoiceConnection {
  // Nothing here reaches the media module: `closed` is about the room alone.
  return new VoiceConnection('channel', false, {} as never, room, 0);
}

test('a room the server ends settles `closed`, and the connection says so', async () => {
  // F-23: a `/disconnect` in a private channel never reached the bot, which
  // kept a dead connection and failed every later `/play` there.
  const room = new FakeRoom();
  const voice = connectionIn(room);
  assert.equal(voice.connected, true);

  room.end();
  await voice.closed;
  assert.equal(voice.connected, false);
  await assert.rejects(voice.play(chunks(FRAME_BYTES)), /left its room/);
});

test('leaving settles `closed` too', async () => {
  const room = new FakeRoom();
  const voice = connectionIn(room);
  await voice.leave();
  await voice.closed;
  assert.equal(voice.connected, false);
});
