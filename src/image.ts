/**
 * What kind of picture some bytes are, and how big, read from their header.
 *
 * Read rather than asked for, because the two things a panel needs from a
 * picture — a name ending the client will draw, and a size to hold room for —
 * are both in the first few hundred bytes, and a caller who got them wrong
 * would get a picture that is not drawn, or a panel that jumps when it lands.
 *
 * Only the four kinds Rift draws in a panel (WIRE.md §5). Anything else is
 * `null`: an SVG is a document rather than a picture, and is exactly the
 * stranger's-code-in-every-client a panel exists to keep out.
 */
export interface ImageInfo {
  readonly extension: 'png' | 'jpg' | 'webp' | 'gif';
  readonly contentType: string;
  /** Absent when the header did not say — the client then sizes it on arrival. */
  readonly width?: number;
  readonly height?: number;
}

export function imageInfo(bytes: Uint8Array): ImageInfo | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('ascii', 12, 16) === 'IHDR') {
    return sized('png', 'image/png', b.readUInt32BE(16), b.readUInt32BE(20));
  }
  if (b.length >= 10 && (b.toString('ascii', 0, 6) === 'GIF87a' || b.toString('ascii', 0, 6) === 'GIF89a')) {
    return sized('gif', 'image/gif', b.readUInt16LE(6), b.readUInt16LE(8));
  }
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    const size = jpegSize(b);
    return sized('jpg', 'image/jpeg', size?.width, size?.height);
  }
  if (b.length >= 16 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
    const size = webpSize(b);
    return sized('webp', 'image/webp', size?.width, size?.height);
  }
  return null;
}

function sized(
  extension: ImageInfo['extension'],
  contentType: string,
  width?: number,
  height?: number,
): ImageInfo {
  const ok = (n?: number) => n !== undefined && n > 0 && n <= 16384;
  return ok(width) && ok(height)
    ? { extension, contentType, width, height }
    : { extension, contentType };
}

/** The first start-of-frame marker's size. Every marker before it is skipped by its length. */
function jpegSize(b: Buffer): { width: number; height: number } | null {
  let at = 2;
  while (at + 9 < b.length) {
    if (b[at] !== 0xff) return null;
    const marker = b[at + 1];
    // SOF0–SOF15, less the three that are not frames: DHT, JPG and DAC.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { height: b.readUInt16BE(at + 5), width: b.readUInt16BE(at + 7) };
    }
    at += 2 + b.readUInt16BE(at + 2);
  }
  return null;
}

/** Lossy, lossless or extended — the three ways a WebP says how big it is. */
function webpSize(b: Buffer): { width: number; height: number } | null {
  const chunk = b.toString('ascii', 12, 16);
  if (chunk === 'VP8 ' && b.length >= 30) {
    return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L' && b.length >= 25) {
    const bits = b.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X' && b.length >= 30) {
    return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 };
  }
  return null;
}
