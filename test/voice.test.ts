import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CHANNELS,
  FRAME_SAMPLES,
  SAMPLE_RATE,
  audioFrames,
  grantAllowsSubscribe,
} from '../src/voice.ts';

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
