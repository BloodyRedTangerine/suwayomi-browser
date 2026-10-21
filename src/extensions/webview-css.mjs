const MAX_RESOURCE_BYTES = 8 * 1024 * 1024;
const MIME_BY_EXTENSION = new Map([
  ['.avif', 'image/avif'], ['.gif', 'image/gif'], ['.jpeg', 'image/jpeg'], ['.jpg', 'image/jpeg'],
  ['.otf', 'font/otf'], ['.png', 'image/png'], ['.svg', 'image/svg+xml'], ['.ttf', 'font/ttf'],
  ['.webp', 'image/webp'], ['.woff', 'font/woff'], ['.woff2', 'font/woff2'],
]);

export function decodeWebViewResource(response, { environmentEncoding = 'utf-8' } = {}) {
  const contentType = getHeader(response.headers, 'content-type') || '';
  const bytes = decodeBase64(response.body || '');
  const bomEncoding = getBomEncoding(bytes);
  const protocolEncoding = getEncoding(/(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1]);
  const declarationEncoding = getCssCharset(bytes);
  const inheritedEncoding = getEncoding(environmentEncoding);
  const encoding = bomEncoding || protocolEncoding || declarationEncoding || inheritedEncoding || 'utf-8';
  return { text: new TextDecoder(encoding).decode(bytes), encoding };
}

export function decodeWebViewResourceText(response, options) {
  return decodeWebViewResource(response, options).text;
}

/**
 * Rewrite CSS subresources to data URLs after fetching them through the
 * caller's WebView resource callback. The opaque document never receives an
 * external CSS/font/image URL that could bypass the optional-host broker.
 */
export async function rewriteWebViewCss(cssText, stylesheetUrl, loadResource, { maxDepth = 8, maxResourceBytes = MAX_RESOURCE_BYTES, environmentEncoding = 'utf-8' } = {}) {
  const activeImports = new Set();
  const base = new URL(stylesheetUrl).href;

  async function rewrite(css, resourceUrl, depth, stylesheetEncoding) {
    if (depth > maxDepth) throw new Error(`WebView CSS import depth exceeds ${maxDepth}.`);
    const canonical = new URL(resourceUrl).href;
    if (activeImports.has(canonical)) return '';
    activeImports.add(canonical);
    try {
      if (byteLength(css) > maxResourceBytes) throw new Error(`WebView CSS exceeds the ${maxResourceBytes}-byte processing limit: ${canonical}`);
      let cursor = 0;
      let copiedThrough = 0;
      const output = [];
      const blockStack = [];
      while (cursor < css.length) {
        if (css.startsWith('/*', cursor)) {
          const end = css.indexOf('*/', cursor + 2);
          cursor = end < 0 ? css.length : end + 2;
          continue;
        }
        const character = css[cursor];
        if (character === '"' || character === "'") {
          cursor = readCssString(css, cursor).end;
          continue;
        }
        if (character === '{') {
          const previousBlock = Math.max(css.lastIndexOf('{', cursor - 1), css.lastIndexOf('}', cursor - 1));
          blockStack.push(/@font-face\b/i.test(css.slice(previousBlock + 1, cursor)));
          cursor++;
          continue;
        }
        if (character === '}') {
          blockStack.pop();
          cursor++;
          continue;
        }

        const importRule = character === '@' && /^@import\b/i.test(css.slice(cursor)) ? parseImport(css, cursor) : null;
        if (importRule) {
          const importedCss = await rewriteReference(importRule.reference.value, canonical, 'stylesheet', loadResource, maxResourceBytes, async (text, finalUrl, encoding) => rewrite(text, finalUrl, depth + 1, encoding), activeImports, stylesheetEncoding);
          if (importedCss === null) {
            output.push(css.slice(copiedThrough, importRule.end));
            cursor = importRule.end;
            copiedThrough = cursor;
            continue;
          }
          output.push(css.slice(copiedThrough, cursor), wrapImportedCss(importedCss, importRule.qualifiers));
          cursor = importRule.end;
          copiedThrough = cursor;
          continue;
        }

        const urlToken = (character === 'u' || character === 'U') ? parseUrlFunction(css, cursor) : null;
        if (urlToken) {
          const dataUrl = await resourceDataUrl(urlToken.value, canonical, loadResource, maxResourceBytes, blockStack.at(-1) ? 'font' : 'image');
          if (dataUrl !== null) {
            output.push(css.slice(copiedThrough, urlToken.tokenStart), `url("${dataUrl}")`);
            cursor = urlToken.tokenEnd;
            copiedThrough = cursor;
            continue;
          }
          cursor = urlToken.tokenEnd;
          continue;
        }
        cursor++;
      }
      output.push(css.slice(copiedThrough));
      return output.join('');
    } finally {
      activeImports.delete(canonical);
    }
  }

  return rewrite(String(cssText || ''), base, 0, getEncoding(environmentEncoding) || 'utf-8');
}

async function rewriteReference(rawUrl, baseUrl, kind, loadResource, maxBytes, rewriteImportedCss, activeImports, environmentEncoding) {
  let target;
  try { target = new URL(rawUrl, baseUrl); } catch { return null; }
  if (!['http:', 'https:'].includes(target.protocol)) return null;
  target.hash = '';
  if (activeImports.has(target.href)) return '';
  const response = await loadResource(target.href, baseUrl, kind);
  if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) return '';
  const bytes = decodeBase64(response.body || '');
  if (bytes.byteLength > maxBytes) throw new Error(`WebView ${kind} exceeds the ${maxBytes}-byte processing limit: ${target.href}`);
  const finalUrl = response.url || target.href;
  const decoded = decodeWebViewResource(response, { environmentEncoding });
  return rewriteImportedCss(decoded.text, finalUrl, decoded.encoding);
}

function getBomEncoding(bytes) {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return 'utf-8';
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

function getCssCharset(bytes) {
  const prefix = [0x40, 0x63, 0x68, 0x61, 0x72, 0x73, 0x65, 0x74, 0x20, 0x22];
  if (bytes.length < prefix.length) return null;
  for (let i = 0; i < prefix.length; i++) if (bytes[i] !== prefix[i]) return null;
  let label = '';
  for (let i = prefix.length; i < Math.min(bytes.length, 1024); i++) {
    const byte = bytes[i];
    if (byte === 0x22) {
      if (i + 1 >= 1024 || bytes[i + 1] !== 0x3b) return null;
      const encoding = getEncoding(label);
      return encoding === 'utf-16le' || encoding === 'utf-16be' ? 'utf-8' : encoding;
    }
    if (!(byte <= 0x21 || byte >= 0x23 && byte <= 0x7f)) return null;
    label += String.fromCharCode(byte);
  }
  return null;
}

function getEncoding(label) {
  if (!label) return null;
  try { return new TextDecoder(String(label).trim()).encoding; }
  catch { return null; }
}

async function resourceDataUrl(rawUrl, baseUrl, loadResource, maxBytes, kind) {
  let target;
  try { target = new URL(rawUrl, baseUrl); } catch { return 'data:,'; }
  if (target.protocol === 'data:' || target.protocol === 'blob:' || target.protocol === 'about:') return null;
  if (!['http:', 'https:'].includes(target.protocol)) return 'data:,';
  target.hash = '';
  const response = await loadResource(target.href, baseUrl, kind);
  if (!response || !Number.isInteger(response.status) || response.status < 200 || response.status >= 300) return 'data:,';
  const bytes = decodeBase64(response.body || '');
  if (bytes.byteLength > maxBytes) throw new Error(`WebView CSS asset exceeds the ${maxBytes}-byte processing limit: ${target.href}`);
  const declared = (getHeader(response.headers, 'content-type') || '').split(';', 1)[0].trim().toLowerCase();
  const extension = new URL(response.url || target.href).pathname.match(/\.[a-z0-9]+$/i)?.[0].toLowerCase();
  const mime = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(declared) ? declared : MIME_BY_EXTENSION.get(extension) || 'application/octet-stream';
  return `data:${mime};base64,${response.body || ''}`;
}

function parseImport(css, start) {
  let cursor = skipSpaceAndComments(css, start + 7);
  let reference;
  if (css[cursor] === '"' || css[cursor] === "'") {
    const string = readCssString(css, cursor);
    reference = { value: string.value, tokenStart: cursor, tokenEnd: string.end };
  } else {
    reference = parseUrlFunction(css, cursor);
    if (!reference) throw new Error(`Unsupported WebView CSS @import syntax near: ${css.slice(start, start + 80)}`);
  }
  const end = findAtRuleEnd(css, reference.tokenEnd);
  const ruleEnd = css[end - 1] === ';' ? end - 1 : end;
  return { reference, qualifiers: css.slice(reference.tokenEnd, ruleEnd).trim(), end };
}

function wrapImportedCss(css, qualifiers) {
  if (!qualifiers) return css;
  let rest = qualifiers.trim();
  let layer = null;
  let supports = null;
  if (/^layer\b/i.test(rest)) {
    rest = rest.slice(5).trimStart();
    if (rest.startsWith('(')) {
      const parsed = readBalancedParentheses(rest, 0);
      layer = parsed.value.trim();
      rest = rest.slice(parsed.end).trimStart();
    } else layer = '';
  }
  if (/^supports\b/i.test(rest)) {
    const open = rest.indexOf('(');
    if (open < 0) throw new Error(`Unsupported WebView CSS @import supports() qualifier: ${qualifiers}`);
    const parsed = readBalancedParentheses(rest, open);
    supports = parsed.value.trim();
    rest = rest.slice(parsed.end).trimStart();
  }
  let result = css;
  if (rest) result = `@media ${rest}{${result}}`;
  if (supports !== null) {
    const condition = /^(?:not\b|\(|selector\(|font-tech\(|font-format\()/i.test(supports) ? supports : `(${supports})`;
    result = `@supports ${condition}{${result}}`;
  }
  if (layer !== null) result = layer ? `@layer ${layer}{${result}}` : `@layer{${result}}`;
  return result;
}

function readBalancedParentheses(text, start) {
  let depth = 0;
  let cursor = start;
  while (cursor < text.length) {
    if (text[cursor] === '"' || text[cursor] === "'") cursor = readCssString(text, cursor).end;
    else if (text.startsWith('/*', cursor)) {
      const end = text.indexOf('*/', cursor + 2);
      cursor = end < 0 ? text.length : end + 2;
    } else if (text[cursor] === '(') { depth++; cursor++; }
    else if (text[cursor] === ')' && --depth === 0) return { value: text.slice(start + 1, cursor), end: cursor + 1 };
    else cursor++;
  }
  throw new Error('Unclosed CSS @import qualifier parentheses.');
}

function parseUrlFunction(css, start) {
  if (!/^url\b/i.test(css.slice(start)) || isCssName(css[start - 1])) return null;
  let cursor = skipSpaceAndComments(css, start + 3);
  if (css[cursor] !== '(') return null;
  cursor = skipSpaceAndComments(css, cursor + 1);
  let value;
  if (css[cursor] === '"' || css[cursor] === "'") {
    const string = readCssString(css, cursor);
    value = string.value;
    cursor = skipSpaceAndComments(css, string.end);
    if (css[cursor] !== ')') return null;
    return { value, tokenStart: start, tokenEnd: cursor + 1 };
  }

  let raw = '';
  while (cursor < css.length && css[cursor] !== ')') {
    if (css.startsWith('/*', cursor)) {
      const end = css.indexOf('*/', cursor + 2);
      cursor = end < 0 ? css.length : end + 2;
      continue;
    }
    if (css[cursor] === '\\') {
      const escaped = readCssEscape(css, cursor);
      raw += escaped.value;
      cursor = escaped.end;
      continue;
    }
    raw += css[cursor++];
  }
  if (css[cursor] !== ')') return null;
  value = raw.trim();
  return { value, tokenStart: start, tokenEnd: cursor + 1 };
}

function readCssString(css, start) {
  const quote = css[start];
  let value = '';
  let cursor = start + 1;
  while (cursor < css.length && css[cursor] !== quote) {
    if (css[cursor] === '\\') {
      const escaped = readCssEscape(css, cursor);
      value += escaped.value;
      cursor = escaped.end;
    } else {
      value += css[cursor++];
    }
  }
  return { value, end: css[cursor] === quote ? cursor + 1 : css.length };
}

function readCssEscape(css, start) {
  let cursor = start + 1;
  if (cursor >= css.length) return { value: '', end: cursor };
  if (css[cursor] === '\n' || css[cursor] === '\r' || css[cursor] === '\f') {
    if (css[cursor] === '\r' && css[cursor + 1] === '\n') cursor++;
    return { value: '', end: cursor + 1 };
  }
  const hex = /^[0-9a-f]{1,6}/i.exec(css.slice(cursor));
  if (!hex) return { value: css[cursor], end: cursor + 1 };
  cursor += hex[0].length;
  if (/\s/.test(css[cursor] || '')) {
    if (css[cursor] === '\r' && css[cursor + 1] === '\n') cursor++;
    cursor++;
  }
  let point = Number.parseInt(hex[0], 16);
  if (!point || point > 0x10ffff || point >= 0xd800 && point <= 0xdfff) point = 0xfffd;
  return { value: String.fromCodePoint(point), end: cursor };
}

function skipSpaceAndComments(css, start) {
  let cursor = start;
  while (cursor < css.length) {
    if (/\s/.test(css[cursor])) cursor++;
    else if (css.startsWith('/*', cursor)) {
      const end = css.indexOf('*/', cursor + 2);
      cursor = end < 0 ? css.length : end + 2;
    } else break;
  }
  return cursor;
}

function findAtRuleEnd(css, start) {
  let cursor = start;
  let depth = 0;
  while (cursor < css.length) {
    if (css.startsWith('/*', cursor)) {
      const end = css.indexOf('*/', cursor + 2);
      cursor = end < 0 ? css.length : end + 2;
    } else if (css[cursor] === '"' || css[cursor] === "'") {
      cursor = readCssString(css, cursor).end;
    } else if (css[cursor] === '(') { depth++; cursor++; }
    else if (css[cursor] === ')') { depth = Math.max(0, depth - 1); cursor++; }
    else if (css[cursor] === ';' && depth === 0) return cursor + 1;
    else cursor++;
  }
  return css.length;
}

function isCssName(value) { return value != null && /[a-z0-9_-]/i.test(value); }

function decodeBase64(value) {
  let raw;
  try { raw = atob(String(value)); } catch { throw new Error('WebView CSS resource body is not valid Base64.'); }
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function encodeBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 16384)
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 16384));
  return btoa(binary);
}

function byteLength(text) { return new TextEncoder().encode(text).byteLength; }

function getHeader(headers, name) {
  const pair = (headers || []).find(entry => Array.isArray(entry) && String(entry[0]).toLowerCase() === name);
  return pair ? String(pair[1]) : '';
}
