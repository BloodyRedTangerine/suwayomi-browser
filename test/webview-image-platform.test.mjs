import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { composeSrcdoc } from '../src/extensions/webview.mjs';

for (const isolatedDataImages of [false, true]) {
  test(`WebView ${isolatedDataImages ? 'declared sandbox data' : 'Chrome blob'} image path preserves CORS and taint`, async () => {
    const html = composeSrcdoc('fixture', 'https://reader.test/page', '', [], [], [], { isolatedDataImages });
    assert.ok(html.includes(`const isolatedDataImages=${isolatedDataImages};`));
    const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const source = script.slice(script.indexOf('function setImageSource('), script.indexOf("Object.defineProperty(HTMLImageElement.prototype,'src'"));
    const nativeURLs = [], requests = [];
    let blobCreates = 0, fileReads = 0, errors = 0;
    const imageTaint = new WeakMap();
    const context = {
      isolatedDataImages, documentOrigin: 'https://reader.test', document: { baseURI: 'https://reader.test/page' },
      imageRequests: new WeakMap(), imageTaint, imageUrls: new WeakMap(), imageBlobs: new WeakMap(),
      imageSource: { set(value) { nativeURLs.push(value); } },
      URL: class extends URL {
        static createObjectURL() { blobCreates++; return 'blob:fixture'; }
        static revokeObjectURL() {}
      },
      FileReader: class {
        readAsDataURL() { fileReads++; queueMicrotask(() => { this.result = 'data:image/png;base64,Zml4dHVyZQ=='; this.onload(); }); }
      },
      Event, upgradeInsecureUrl: value => new URL(value), originOf: value => new URL(value).origin,
      corsAllowed: (response, mode) => response.headers.get('access-control-allow-origin') === '*',
      brokerFetch: async (url, options, directive) => {
        requests.push({ url, directive });
        return { ok: true, url, headers: new Headers(url.includes('/allowed') ? { 'access-control-allow-origin': '*' } : {}),
          blob: async () => new Blob(['fixture'], { type: 'image/png' }) };
      },
    };
    vm.runInNewContext(source, context);
    const makeImage = cors => ({ hasAttribute: name => name === 'crossorigin' && cors !== null,
      crossOrigin: cors, dispatchEvent: () => { errors++; } });
    const same = makeImage(null), foreign = makeImage(null), allowed = makeImage('anonymous'), denied = makeImage('anonymous');
    context.setImageSource(same, 'https://reader.test/cover');
    context.setImageSource(foreign, 'https://cdn.test/cover');
    context.setImageSource(allowed, 'https://cdn.test/allowed');
    context.setImageSource(denied, 'https://cdn.test/denied');
    for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(errors, 1, 'CORS denial must still emit an image error');
    assert.equal(nativeURLs.length, 3, 'CORS-denied bytes must not reach decoding');
    assert.ok(nativeURLs.every(value => value.startsWith(isolatedDataImages ? 'data:' : 'blob:')));
    assert.equal(fileReads, isolatedDataImages ? 3 : 0);
    assert.equal(blobCreates, isolatedDataImages ? 0 : 3);
    assert.equal(imageTaint.get(same), false);
    assert.equal(imageTaint.get(foreign), true);
    assert.equal(imageTaint.get(allowed), false);
    assert.equal(imageTaint.has(denied), false);
    assert.ok(requests.every(row => row.directive === 'img-src'));
  });
}
