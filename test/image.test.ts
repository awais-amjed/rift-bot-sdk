import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { imageInfo } from '../src/image.ts';

/**
 * A panel holds room for its picture from the size the bot sends, so a wrong
 * size is a panel that jumps when the picture lands. Every way each format
 * can say how big it is, read from real files ffmpeg made at 37×23.
 */
const fixture = (name: string) =>
  readFileSync(new URL(`./fixtures/${name}`, import.meta.url));

test('reads the kind and the size of each format a panel draws', () => {
  for (const [file, extension] of [
    ['37x23.png', 'png'],
    ['37x23.jpg', 'jpg'],
    ['37x23.gif', 'gif'],
    ['37x23.webp', 'webp'], // lossy, `VP8 `
    ['37x23-lossless.webp', 'webp'], // `VP8L`
    ['37x23-alpha.webp', 'webp'], // extended, `VP8X`
  ] as const) {
    const info = imageInfo(fixture(file));
    assert.equal(info?.extension, extension, file);
    assert.equal(info?.width, 37, file);
    assert.equal(info?.height, 23, file);
  }
});

test('anything else is not a picture a panel can show', () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>');
  assert.equal(imageInfo(svg), null);
  assert.equal(imageInfo(Buffer.alloc(0)), null);
});

test('a header cut short still names the kind, without a size', () => {
  // The client then sizes it once it lands, which is a jump but not a
  // picture that is never drawn.
  const jpeg = fixture('37x23.jpg').subarray(0, 4);
  assert.deepEqual(imageInfo(jpeg), { extension: 'jpg', contentType: 'image/jpeg' });
});
