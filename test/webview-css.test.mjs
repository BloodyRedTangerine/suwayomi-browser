import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeBytes } from '../src/extensions/transport.mjs';
import { decodeWebViewResource, rewriteWebViewCss } from '../src/extensions/webview-css.mjs';

const response = (status, contentType, bytes, url = '') => ({
  status,
  url,
  headers: contentType ? [['Content-Type', contentType]] : [],
  body: encodeBytes(bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes)),
});

const legacyBytes = text => Uint8Array.from([...text], character => character.charCodeAt(0));

test('WebView CSS decoding honors BOM, protocol charset, @charset and inherited import encoding', async () => {
  const protocolDecoded = decodeWebViewResource(response(200, 'text/css; charset=windows-1252', legacyBytes('.x::after{content:"caf\xe9"}')));
  assert.equal(protocolDecoded.text, '.x::after{content:"café"}');
  assert.equal(protocolDecoded.encoding, 'windows-1252');

  const declaredBytes = legacyBytes('@charset "windows-1252";.x::after{content:"caf\xe9"}');
  const declaredDecoded = decodeWebViewResource(response(200, '', declaredBytes));
  assert.equal(declaredDecoded.text, '@charset "windows-1252";.x::after{content:"café"}');
  assert.equal(declaredDecoded.encoding, 'windows-1252');

  const protocolWins = decodeWebViewResource(response(200, 'text/css; charset=windows-1252', legacyBytes('@charset "utf-8";.x::after{content:"caf\xe9"}')));
  assert.equal(protocolWins.text, '@charset "utf-8";.x::after{content:"café"}');
  assert.equal(protocolWins.encoding, 'windows-1252');
  assert.equal(decodeWebViewResource(response(200, 'text/css; charset=invalid-label', declaredBytes)).encoding, 'windows-1252');
  assert.equal(decodeWebViewResource(response(200, '', legacyBytes('@charset "utf-16";.x{color:red}'))).encoding, 'utf-8');
  const overlongLabel = `@charset "${' '.repeat(1001)}windows-1252";.x::after{content:"caf\xe9"}`;
  const boundedDeclaration = decodeWebViewResource(response(200, '', legacyBytes(overlongLabel)));
  assert.equal(boundedDeclaration.encoding, 'utf-8');
  assert.match(boundedDeclaration.text, /caf\ufffd/);

  const bomText = new TextEncoder().encode('.x::after{content:"café"}');
  const bomBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...bomText]);
  assert.equal(decodeWebViewResource(response(200, 'text/css; charset=windows-1252', bomBytes)).text, '.x::after{content:"café"}');

  const imported = await rewriteWebViewCss('@import "nested.css";', 'https://style.example.test/root.css', async url => {
    assert.equal(url, 'https://style.example.test/nested.css');
    return response(200, 'text/css', legacyBytes('.nested::after{content:"caf\xe9"}'), url);
  }, { environmentEncoding: 'windows-1252' });
  assert.match(imported, /content:"café"/);
});

test('WebView CSS brokers imports, escaped font URLs and image assets while preserving CSS grammar', async () => {
  const requests = [];
  const rootUrl = 'https://style.example.test/css/theme.css';
  const nestedUrl = 'https://style.example.test/css/nested.css';
  const fontUrl = 'https://style.example.test/fonts/probe%20font.woff2';
  const heroUrl = 'https://style.example.test/css/images/hero.svg?theme=1';
  const iconUrl = 'https://style.example.test/css/icons/card.svg';
  const fontBytes = new Uint8Array([0, 1, 127, 255]);
  const resources = new Map([
    [nestedUrl, response(200, 'text/css; charset=utf-8', '.card{background-image:url("icons/card.svg")} ', nestedUrl)],
    [fontUrl, response(200, '', fontBytes, fontUrl)],
    [heroUrl, response(200, 'image/svg+xml', '<svg/>', heroUrl)],
    [iconUrl, response(200, 'image/svg+xml', '<svg/>', iconUrl)],
  ]);
  const css = [
    '/* url(comment.png) */',
    '@import url("nested.css") screen and (min-width: 1px);',
    '@font-face{font-family:Probe;src:url(../fonts/probe\\20 font.woff2) format("woff2")}',
    '.hero{background-image:url("images/hero.svg?theme=1");content:"url(not-requested.png)"}',
  ].join('\n');

  const rewritten = await rewriteWebViewCss(css, rootUrl, async (url, referrer, kind) => {
    requests.push({ url, referrer, kind });
    return resources.get(url) || response(404, '', new Uint8Array());
  });

  assert.deepEqual(requests, [
    { url: nestedUrl, referrer: rootUrl, kind: 'stylesheet' },
    { url: iconUrl, referrer: nestedUrl, kind: 'image' },
    { url: fontUrl, referrer: rootUrl, kind: 'font' },
    { url: heroUrl, referrer: rootUrl, kind: 'image' },
  ]);
  assert.match(rewritten, /@media screen and \(min-width: 1px\)\{\.card\{background-image:url\("data:image\/svg\+xml;base64,/);
  assert.match(rewritten, /url\("data:font\/woff2;base64,AAF\/\/w=="\)/);
  assert.match(rewritten, /url\("data:image\/svg\+xml;base64,/);
  assert.doesNotMatch(rewritten, /https:\/\/style\.example\.test/);
  assert.equal(requests.some(({ url }) => url.endsWith('comment.png') || url.endsWith('not-requested.png')), false);
  assert.match(rewritten, /@font-face\{font-family:Probe;src:url\("data:font\/woff2;base64,/);
});

test('WebView CSS missing assets degrade to empty data URLs, local URLs stay local, and import cycles terminate', async () => {
  const requests = [];
  const sourceUrl = 'https://style.example.test/css/root.css';
  const localImport = '@import url("data:text/css;base64,Ym9keXtjb2xvcjpyZWR9");';
  const rewritten = await rewriteWebViewCss(
    `${localImport}\n@import "missing.css";\n.x{background:url(missing.png)}`, sourceUrl,
    async url => {
      requests.push(url);
      return response(404, '', new Uint8Array());
    },
  );
  assert.equal(requests.length, 2);
  assert.match(rewritten, /@import url\("data:text\/css;base64,Ym9keXtjb2xvcjpyZWR9"\);/);
  assert.doesNotMatch(rewritten, /missing\.css/);
  assert.match(rewritten, /background:url\("data:,"\)/);

  const cycleRequests = [];
  const cycleCss = await rewriteWebViewCss('@import "nested.css";', sourceUrl, async url => {
    cycleRequests.push(url);
    return response(200, 'text/css; charset=utf-8', '@import "root.css"; .nested{color:blue}', url);
  });
  assert.deepEqual(cycleRequests, ['https://style.example.test/css/nested.css']);
  assert.match(cycleCss, /\.nested\{color:blue\}/);
  assert.doesNotMatch(cycleCss, /root\.css/);
});

test('WebView CSS preserves @import layer, supports and media qualifiers when inlining brokered sheets', async () => {
  const rewritten = await rewriteWebViewCss(
    '@import "qualified.css" layer(ui) supports(display: grid) screen and (min-width: 5px);',
    'https://style.example.test/css/root.css',
    async url => response(200, 'text/css; charset=utf-8', '.qualified{color:blue}', url),
  );
  assert.equal(rewritten, '@layer ui{@supports (display: grid){@media screen and (min-width: 5px){.qualified{color:blue}}}}');
});
