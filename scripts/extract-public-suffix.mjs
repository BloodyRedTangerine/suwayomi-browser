// Extract the pinned OkHttp PSL already distributed in the host JAR. No network.
import { readFile } from 'node:fs/promises';
import { unzipSync } from 'fflate';
import { createHash } from 'node:crypto';
const name = 'okhttp3/internal/publicsuffix/PublicSuffixDatabase.list';
const bytes = unzipSync(await readFile(new URL('../runtime/extension-host.jar', import.meta.url)), { filter: entry => entry.name === name })[name];
if (!bytes) throw new Error('Pinned OkHttp public suffix resource missing');
const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
const length = view.getUint32(0), exceptionLength = view.getUint32(4 + length);
if (8 + length + exceptionLength !== bytes.length) throw new Error('Invalid PSL resource framing');
const normalize = rule => {
  const wildcard = rule.startsWith('*.');
  const host = new URL('https://' + (wildcard ? rule.slice(2) : rule)).hostname;
  return (wildcard ? '*.' : '') + host;
};
const rules = new TextDecoder().decode(bytes.subarray(4, 4 + length)).trim().split('\n').map(normalize);
const exceptions = new TextDecoder().decode(bytes.subarray(8 + length)).trim().split('\n').filter(Boolean).map(normalize);
// stdout is consumed by the patch-generation orchestration, not a shell file write.
console.log(JSON.stringify({ sha256: createHash('sha256').update(bytes).digest('hex'), rules, exceptions }));
