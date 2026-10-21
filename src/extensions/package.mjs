import { unzipSync, strFromU8 } from '../../vendor/fflate.mjs';
import { contentWarningFromMetadata } from './metadata.mjs';

export function inspectExtension(bytes, xmlText = null) {
  if (bytes.byteLength > 64 * 1024 * 1024) throw new Error('Extension archive exceeds the 64 MiB browser import limit.');
  let hasDex = false;
  const files = unzipSync(bytes, { filter: entry => {
    if (/^classes\d*\.dex$/.test(entry.name)) hasDex = true;
    if (entry.name !== 'AndroidManifest.xml') return false;
    if (entry.originalSize > 2 * 1024 * 1024) throw new Error('Extension manifest is too large.');
    return true;
  } });
  const manifestBytes = files['AndroidManifest.xml'];
  if (!manifestBytes) throw new Error('This archive has no AndroidManifest.xml.');
  if (!xmlText) {
    const text = strFromU8(manifestBytes).trim();
    if (!text.startsWith('<')) return { needsBinaryManifest: true };
    xmlText = text;
  }
  const xml = new DOMParser().parseFromString(xmlText, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('Invalid extension manifest.');
  const android = 'http://schemas.android.com/apk/res/android';
  const attr = (node, key) => node?.getAttributeNS(android, key);
  const root = xml.documentElement;
  const metadata = Object.fromEntries([...xml.querySelectorAll('application > meta-data')].map(n => [attr(n, 'name'), attr(n, 'value')]));
  const pkg = root.getAttribute('package');
  const classes = (metadata['tachiyomi.extension.class'] || metadata['tachiyomi.extension.factory'] || '').split(';').map(x => x.trim()).filter(Boolean).map(x => x.startsWith('.') ? pkg + x : x);
  if (!pkg || !classes.length) throw new Error('This archive is not a Mihon/Suwayomi source extension.');
  if (![...xml.querySelectorAll('uses-feature')].some(n => attr(n, 'name') === 'tachiyomi.extension')) throw new Error('Missing Tachiyomi extension feature.');
  let libraryVersion = metadata['tachiyomix.extensionLib'];
  // apk-parser represents Android's typed float metadata as {4:<raw bits>}.
  const binaryFloat = /^\{4:(\d+)\}$/.exec(libraryVersion || '');
  if (binaryFloat) {
    const view = new DataView(new ArrayBuffer(4));
    view.setUint32(0, Number(binaryFloat[1]));
    libraryVersion = view.getFloat32(0).toFixed(1);
  }
  libraryVersion ||= attr(root, 'versionName')?.split('.').slice(0, 2).join('.');
  if (!['1.3', '1.4', '1.5', '1.6'].includes(libraryVersion)) throw new Error('Unsupported extension API version: ' + libraryVersion);
  return {
    packageName: pkg, classes, libraryVersion, contentWarning: contentWarningFromMetadata(metadata),
    name: metadata['tachiyomix.name'] || attr(xml.querySelector('application'), 'label') || pkg,
    version: attr(root, 'versionName'),
    versionCode: attr(root, 'versionCode') || '0',
    format: hasDex ? 'apk' : 'jar',
  };
}
