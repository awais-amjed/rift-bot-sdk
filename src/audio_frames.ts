/**
 * Cutting a byte stream into the frames LiveKit publishes.
 *
 * Its own file because it is the one piece of the voice path with no network,
 * no room and no key in it — pure, and therefore testable without a WebRTC
 * stack. That matters more here than the line count: the failure it guards is a
 * click you can only hear.
 */

/**
 * How many key slots LiveKit's ring holds.
 *
 * Rift addresses keys by channel key *version* and maps them on as
 * `version % KEY_RING_SIZE`. Every client has to use the same number, or a
 * sender encrypts into a slot its listeners do not read — a call where
 * everybody connects, every track publishes, and nobody hears anyone, with no
 * error reported anywhere. WIRE.md §6 freezes it.
 */
export const KEY_RING_SIZE = 16;

/** What LiveKit wants and what `ffmpeg -f s16le -ar 48000 -ac 2` produces. */
export const SAMPLE_RATE = 48000;
export const CHANNELS = 2;

/**
 * How much audio one `AudioFrame` carries. 10ms is LiveKit's own tick — larger
 * frames add latency to a skip, smaller ones spend more time in the bridge than
 * in the codec.
 */
export const FRAME_SAMPLES = SAMPLE_RATE / 100;

/** Bytes in one frame: samples × channels × two bytes a sample. */
const FRAME_BYTES = FRAME_SAMPLES * CHANNELS * 2;

/**
 * Cut a byte stream into whole audio frames.
 *
 * Exported, and a generator, so it can be tested without a WebRTC stack — the
 * carry is the part worth testing. A stream hands over whatever the pipe had,
 * so a chunk boundary almost never lands on a frame boundary; publishing a
 * short frame at each one instead of carrying the tail forward puts an audible
 * click wherever the chunks happen to fall, several a second on a 64KB pipe.
 * That is a bug you can only hear, which is the kind worth a test.
 *
 * A trailing partial frame at the end of the stream is dropped. It is under
 * 10ms of silence at the end of a track, and padding it would mean inventing
 * samples nobody sent.
 */
export async function* audioFrames(
  pcm: AsyncIterable<Uint8Array>,
  shouldContinue: () => boolean = () => true,
): AsyncGenerator<Int16Array> {
  let carry = new Uint8Array(0);

  for await (const chunk of pcm) {
    if (!shouldContinue()) return;

    let buffer: Uint8Array;
    if (carry.length === 0) {
      buffer = chunk;
    } else {
      buffer = new Uint8Array(carry.length + chunk.length);
      buffer.set(carry, 0);
      buffer.set(chunk, carry.length);
    }

    let offset = 0;
    while (buffer.length - offset >= FRAME_BYTES) {
      // Copied rather than viewed, and copied the long way round on purpose.
      //
      // A frame outlives this iteration inside LiveKit's queue, so it must not
      // alias the chunk. `buffer.slice` looks like the copy and is not one when
      // `buffer` is a Node `Buffer` — there `slice` is an alias of `subarray`,
      // which shares memory — and a Buffer is exactly what a stream yields.
      //
      // The copy also fixes the alignment. `new Int16Array(ab, byteOffset, …)`
      // throws when `byteOffset` is odd, and a pooled Buffer's offset is
      // whatever the pool handed out.
      const bytes = new Uint8Array(buffer.subarray(offset, offset + FRAME_BYTES));
      yield new Int16Array(bytes.buffer, 0, FRAME_SAMPLES * CHANNELS);
      offset += FRAME_BYTES;
    }
    // Copied for the same reason: the carry is read on the *next* chunk, by
    // which time this one may be gone.
    carry = new Uint8Array(buffer.subarray(offset));
  }
}
