import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectRaster, validateDimensions, imageOperation } from '../src/extensions/image-codec.mjs';
import { decodeBytes, encodeBytes } from '../src/extensions/transport.mjs';
const png = decodeBytes('iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR4nGP4zwBEIAikwQAAScgJ94C76UsAAAAASUVORK5CYII=');

test('Raster header preflight reads PNG, GIF, JPEG and WebP dimensions', () => {
  assert.deepEqual(inspectRaster(png), { width: 2, height: 2, mime: 'image/png' });
  const gif = Uint8Array.from([71,73,70,56,57,97,3,0,5,0]);
  assert.deepEqual(inspectRaster(gif), { width: 3, height: 5, mime: 'image/gif' });
  const jpeg = new Uint8Array(21); const j = new DataView(jpeg.buffer);
  j.setUint16(0, 0xffd8); j.setUint16(2, 0xffc0); j.setUint16(4, 17); jpeg[6] = 8; j.setUint16(7, 3); j.setUint16(9, 5);
  assert.deepEqual(inspectRaster(jpeg), { width: 5, height: 3, mime: 'image/jpeg' });
  const webp = new Uint8Array(30);
  webp.set(new TextEncoder().encode('RIFF'), 0); webp.set(new TextEncoder().encode('WEBPVP8X'), 8); webp[24] = 2; webp[27] = 4;
  assert.deepEqual(inspectRaster(webp), { width: 3, height: 5, mime: 'image/webp' });
  const lossless = new Uint8Array(25); lossless.set(new TextEncoder().encode('RIFF'), 0); lossless.set(new TextEncoder().encode('WEBPVP8L'), 8); lossless[20] = 47;
  new DataView(lossless.buffer).setUint32(21, 1 | (3 << 14), true);
  assert.deepEqual(inspectRaster(lossless), { width: 2, height: 4, mime: 'image/webp' });
});

test('Raster preflight rejects oversized dimensions, malformed headers and SVG before decoding', async () => {
  for (const [w, h] of [[0, 2], [-1, 2], [1.5, 2], [65536, 1], [4096, 4096]]) assert.throws(() => validateDimensions(w, h), /limits/);
  for (let i = 0; i < 24; i++) assert.throws(() => inspectRaster(png.slice(0, i)));
  const huge = png.slice(); new DataView(huge.buffer).setUint32(16, 65536);
  await assert.rejects(imageOperation({ action: 'decode', body: encodeBytes(huge) }), /limits/);
  await assert.rejects(imageOperation({ action: 'decode', body: encodeBytes(new TextEncoder().encode('<svg><image href="https://not-contacted.test"/></svg>')) }), /unsupported/);
  const truncatedJpeg = Uint8Array.from([255,216,255,192,0,255,8,0,2]);
  assert.throws(() => inspectRaster(truncatedJpeg), /Invalid/);
});

test('Bounds-only requests do not require a browser decoder or pixel allocation', async () => {
  assert.deepEqual(await imageOperation({ action: 'decode', boundsOnly: true, body: encodeBytes(png) }), { width: 2, height: 2, mime: 'image/png' });
});

test('Image encoding validates raw windows, quality, MIME and operation before canvas use', async () => {
  const request = { action: 'encode', width: 2, height: 2, mime: 'image/png', quality: 90, body: encodeBytes(new Uint8Array(16)) };
  await assert.rejects(imageOperation({ ...request, body: encodeBytes(new Uint8Array(15)) }), /byte count/);
  await assert.rejects(imageOperation({ ...request, quality: 101 }), /quality/);
  await assert.rejects(imageOperation({ ...request, mime: 'image/avif' }), /format/);
  await assert.rejects(imageOperation({ ...request, action: 'fetch' }), /Unknown/);
});

test('Text layout uses browser Canvas2D metrics, wraps long tokens, and returns bounded RGBA pixels', async () => {
  const previous = globalThis.OffscreenCanvas;
  class MockCanvas {
    constructor(width, height) { this.width = width; this.height = height; this.context = new MockContext(this); }
    getContext() { return this.context; }
  }
  class MockContext {
    constructor(canvas) { this.canvas = canvas; this.font = ''; this.fillStyle = ''; this.calls = []; }
    measureText(text) { return { width: [...text].length * 8, fontBoundingBoxAscent: 10, fontBoundingBoxDescent: 3 }; }
    save() {}
    restore() {}
    transform(...args) { this.calls.push(['transform', ...args]); }
    fillText(text, x, y) { this.calls.push(['fillText', text, x, y]); }
    fillRect() {}
    getImageData(x, y, width, height) {
      const data = new Uint8ClampedArray(width * height * 4);
      if (this.calls.some(call => call[0] === 'fillText')) data[3] = 255;
      return { data };
    }
  }
  globalThis.OffscreenCanvas = MockCanvas;
  try {
    const layout = await imageOperation({ action: 'layoutText', text: 'one extraordinarilylongword two', width: 40,
      color: 0xff123456, textSize: 14, family: 'serif', style: 1, fakeBold: false, underline: false,
      strike: false, textScaleX: 1, textSkewX: 0, alignment: 0, spacingMultiplier: 1, spacingExtra: 0, includePad: true });
    const pixels = decodeBytes(layout.body);
    assert.equal(layout.width, 40);
    assert.ok(layout.lines >= 3, `expected wrapped words and long-token splitting, got ${layout.lines}`);
    assert.equal(pixels.length, layout.width * layout.height * 4);
    assert.equal(pixels[3], 255);
    await assert.rejects(imageOperation({ action: 'layoutText', text: 'x', width: 0, textSize: 14 }), /width/);

    const sample = 'a a a a a';
    const boundaryMap = positions => {
      const bytes = new Uint8Array(Math.ceil((sample.length + 1) / 8));
      for (const position of positions) bytes[position >>> 3] |= 1 << (position & 7);
      return encodeBytes(bytes);
    };
    const common = {
      action: 'layoutText', text: sample, width: 32, textSize: 14, style: 0, alignment: 0,
      textScaleX: 1, textSkewX: 0, spacingMultiplier: 1, spacingExtra: 0,
      lineBreaks: boundaryMap([0, 2, 4, 6, 8, 9]),
      graphemeBreaks: boundaryMap(Array.from({ length: sample.length + 1 }, (_, index) => index)),
    };
    const simple = await imageOperation({ ...common, breakStrategy: 0 });
    const balanced = await imageOperation({ ...common, breakStrategy: 2 });
    assert.deepEqual(simple.lineEnds, [4, 8, 9]);
    assert.deepEqual(balanced.lineEnds, [2, 6, 9]);
    assert.deepEqual(balanced.lineWidths, [8, 24, 24]);
  } finally {
    if (previous === undefined) delete globalThis.OffscreenCanvas;
    else globalThis.OffscreenCanvas = previous;
  }
});
