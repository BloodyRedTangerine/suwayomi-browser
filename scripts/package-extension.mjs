import { access, mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { unzipSync } from 'fflate';
import { assertNoPrivateKeyMaterial } from './package-output-guard.mjs';
import { targetManifest } from './target-manifest.mjs';
import { root, upstream } from './paths.mjs';

// Usage: node scripts/package-extension.mjs <new absolute output directory> [--target=chrome|firefox]
// The output is the unpacked extension only: product files, LICENSE, DEPENDENCIES.json and THIRD_PARTY_LICENSES.
// No tests, no source archive, no developer notes ship in a package; the source is the repository.
const target = process.argv[2];
const targetOption = process.argv.slice(3);
if (targetOption.length > 1 || targetOption.some(value => !/^--target=(chrome|firefox)$/.test(value)))
  throw new Error('Expected optional --target=chrome|firefox');
const platform = targetOption[0]?.slice('--target='.length) || 'chrome';
if (!target || !isAbsolute(target)) throw new Error('Provide a new absolute output directory. Existing directories are never replaced.');

const uiProvenance = JSON.parse(await readFile(resolve(root, 'ui/UPSTREAM.json'), 'utf8'));
if (uiProvenance.syntheticSources !== false || uiProvenance.offlineTest !== false) throw new Error('Rebuild the production WebUI; packaging an unmarked, synthetic-source or offline-test frontend is not allowed.');
const dependencies = (await readFile(resolve(root, 'jvm/build/runtime-dependencies.tsv'), 'utf8')).trim().split('\n').filter(Boolean).sort();
for (const path of ['manifest.json', 'ui/UPSTREAM.json', 'runtime/extension-host.jar', 'runtime/vm/bjvm_main.wasm', 'vendor/bjvm/bjvm.mjs', 'vendor/bjvm/jre/PROVENANCE.json', 'vendor/quickjs.wasm', 'vendor/webui-modules.json', 'vendor/js-modules.json'])
  await access(resolve(root, path));
for (const name of ['LICENSE', 'ZSTD-LICENSE', 'ZSTD-COPYING', 'ZSTD-PROVENANCE.json']) await access(resolve(root, 'vendor/bjvm', name));
const licenseFile = await access(resolve(root, 'LICENSE')).then(() => resolve(root, 'LICENSE'), () => resolve(root, '../LICENSE'));
await mkdir(target); // Deliberately fails if the target already exists.
const copy = async (source, destination, filter) => {
  await mkdir(dirname(destination), { recursive: true });
  await cp(source, destination, { recursive: true, filter });
};
// src/app.mjs is the retired prototype UI: nothing in the extension loads it.
const srcFilter = path => !/[\\/]src[\\/]app\.mjs$/.test(path);
for (const path of ['manifest.json', 'extension-background.mjs', 'launcher.html', 'launcher.mjs', 'index.html', 'recovery.html', 'src', 'ui', 'runtime/extension-host.jar', 'runtime/vm/bjvm_main.js', 'runtime/vm/bjvm_main.wasm', 'vendor/fflate.mjs', 'vendor/quickjs.mjs', 'vendor/quickjs.wasm', 'vendor/bjvm/bjvm.mjs', 'vendor/bjvm/LICENSE', 'vendor/bjvm/jre'])
  await copy(resolve(root, path), join(target, path), srcFilter);
const sourceManifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
await writeFile(join(target, 'manifest.json'), JSON.stringify(targetManifest(sourceManifest, platform), null, 2) + '\n');
await copy(licenseFile, join(target, 'LICENSE'));
for (const name of ['ZSTD-LICENSE', 'ZSTD-COPYING', 'ZSTD-PROVENANCE.json']) await copy(resolve(root, 'vendor/bjvm', name), join(target, 'vendor/bjvm', name));

// ---------------------------------------------------------------------------------------------------------------
// Third-party notices, limited to what is shipped.
// ---------------------------------------------------------------------------------------------------------------
const notices = join(target, 'THIRD_PARTY_LICENSES');
const LICENSE_NAME = /^(?:license|licence|copying|notice|copyright|unlicense|patents)(?:[._-].*)?$/i;
const index = { jvm: [], webui: [], runtime: [] };

// JVM runtime dependencies (the host JAR bundles them): notices embedded in each artifact.
const inventory = [];
for (const line of dependencies) {
  const [coordinate, path] = line.split('\t');
  const bytes = await readFile(path);
  const licenses = unzipSync(bytes, { filter: entry => /(?:^|\/)(?:license|licence|copying|notice|copyright)(?:[._-][^/]*)?$/i.test(entry.name) });
  const licensePaths = [];
  for (const [name, contents] of Object.entries(licenses).sort(([a], [b]) => a < b ? -1 : 1)) {
    const safeName = name.split('/').filter(part => part && part !== '.' && part !== '..').join('/');
    const output = join(notices, 'jvm', coordinate.replace(/:/g, '_'), safeName);
    await mkdir(dirname(output), { recursive: true }); await writeFile(output, contents);
    licensePaths.push(relative(target, output).split(sep).join('/'));
  }
  inventory.push({ coordinate, sha256: createHash('sha256').update(bytes).digest('hex'), embeddedNotices: licensePaths });
  index.jvm.push({ name: coordinate, notices: licensePaths });
}
const apacheLicense = inventory.find(item => item.coordinate.startsWith('com.fasterxml.jackson.core:jackson-annotations:'))?.embeddedNotices.find(path => path.endsWith('/LICENSE'));
if (!apacheLicense) throw new Error('Apache-2.0 license text is required for the bundled AndroidCompat Base64 implementation.');
await copy(join(target, apacheLicense), join(notices, 'AndroidCompat/APACHE-2.0.txt'));
await writeFile(join(notices, 'AndroidCompat/NOTICE.txt'), `android.util.Base64: Copyright (C) 2010 The Android Open Source Project. Apache-2.0.\nCompiled into the extension host JAR from the unmodified Suwayomi-Server AndroidCompat sources at revision ${upstream.server.revision}.\n`);

// npm packages bundled into the shipped JavaScript (module lists written by the bundlers).
async function packageDirectory(id, base) {
  let path = id.replace(/^\0/, '').replace(/\?.*$/, '');
  if (!isAbsolute(path)) path = resolve(base, path);
  const marker = sep + 'node_modules' + sep;
  const at = path.lastIndexOf(marker);
  if (at === -1) return null;
  const parts = path.slice(at + marker.length).split(sep);
  const name = parts[0].startsWith('@') ? parts[0] + '/' + parts[1] : parts[0];
  return path.slice(0, at + marker.length) + name;
}
async function collectNpm(label, list, base) {
  const directories = new Set();
  for (const id of list) { const directory = await packageDirectory(id, base); if (directory) directories.add(directory); }
  const found = [];
  for (const directory of directories) {
    let manifest;
    try { manifest = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8')); } catch { continue; }
    const key = `${manifest.name}@${manifest.version}`;
    const files = (await readdir(directory, { withFileTypes: true })).filter(entry => entry.isFile() && LICENSE_NAME.test(entry.name)).map(entry => entry.name).sort();
    found.push({ key, name: manifest.name, version: manifest.version, license: typeof manifest.license === 'string' ? manifest.license : manifest.license?.type || (manifest.licenses ? manifest.licenses.map(item => item.type).join(' OR ') : 'see notice files'), directory, files });
  }
  found.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0);
  const seen = new Set();
  for (const item of found) {
    if (seen.has(item.key)) continue; seen.add(item.key);
    const output = [];
    for (const file of item.files) {
      const destination = join(notices, label, item.name.replace('/', '__') + '@' + item.version, file);
      await mkdir(dirname(destination), { recursive: true });
      await cp(join(item.directory, file), destination);
      output.push(relative(target, destination).split(sep).join('/'));
    }
    index[label === 'webui-js' ? 'webui' : 'runtime'].push({ name: item.key, license: item.license, notices: output });
  }
}
const webuiModules = JSON.parse(await readFile(resolve(root, 'vendor/webui-modules.json'), 'utf8'));
const jsModules = JSON.parse(await readFile(resolve(root, 'vendor/js-modules.json'), 'utf8'));
await collectNpm('webui-js', webuiModules, root);
await collectNpm('runtime-js', jsModules, root);

// VM, Zstandard and the bundled JRE class libraries.
await copy(resolve(root, 'vendor/bjvm/LICENSE'), join(notices, 'b-jvm/LICENSE'));
await copy(resolve(root, 'vendor/bjvm/ZSTD-LICENSE'), join(notices, 'zstd/LICENSE'));
await copy(resolve(root, 'vendor/bjvm/ZSTD-COPYING'), join(notices, 'zstd/COPYING'));
await copy(resolve(root, 'ui/LICENSE-MPL-2.0'), join(notices, 'suwayomi-webui/LICENSE-MPL-2.0'));

const rows = [];
rows.push('# Third-party components shipped in this package', '',
  'Only components that are part of this package are listed. Verbatim licence texts sit next to each entry (or, for the',
  'JRE class libraries, under `vendor/bjvm/jre/legal/`). Source: the repository named in `manifest.json` (`homepage_url`);',
  'upstream revisions are recorded in `UPSTREAM.json` of the source release.', '',
  '| Component | Version / revision | Licence | Where its notice is |', '|---|---|---|---|',
  `| Suwayomi WebUI (patched, built from source) | ${upstream.webui.revision.slice(0, 12)} | MPL-2.0 | \`THIRD_PARTY_LICENSES/suwayomi-webui/LICENSE-MPL-2.0\` |`,
  `| b-jvm WebAssembly JVM (patched, built from source) | ${upstream.vm.revision.slice(0, 12)} | MIT | \`THIRD_PARTY_LICENSES/b-jvm/LICENSE\` |`,
  `| Zstandard | ${upstream.zstd.version} (${upstream.zstd.revision.slice(0, 12)}) | BSD-3-Clause or GPL-2.0 | \`THIRD_PARTY_LICENSES/zstd/\` |`,
  `| Amazon Corretto / OpenJDK class libraries (incl. jdk.localedata) | ${upstream.corretto.version} | GPL-2.0 with Classpath Exception | \`vendor/bjvm/jre/legal/\` |`,
  '| Android Open Source Project Base64 | upstream revision above | Apache-2.0 | `THIRD_PARTY_LICENSES/AndroidCompat/` |');
for (const item of index.runtime) rows.push(`| ${item.name} (runtime JavaScript) | ${item.name.split('@').pop()} | ${item.license} | ${item.notices.map(path => '`' + path + '`').join(', ') || 'none shipped by the package; licence field only'} |`);
for (const item of index.webui) rows.push(`| ${item.name} (WebUI bundle) | ${item.name.split('@').pop()} | ${item.license} | ${item.notices.map(path => '`' + path + '`').join(', ') || 'none shipped by the package; licence field only'} |`);
for (const item of index.jvm) rows.push(`| ${item.name} (host JAR) | ${item.name.split(':').pop()} | see notices | ${item.notices.map(path => '`' + path + '`').join(', ') || 'no notice file inside the artifact'} |`);
await writeFile(join(notices, 'INDEX.md'), rows.join('\n') + '\n');
await writeFile(join(target, 'DEPENDENCIES.json'), JSON.stringify(inventory, null, 2) + '\n');
await assertNoPrivateKeyMaterial(target);
console.log(`Prepared ${platform} extension ${sourceManifest.version} at ${target}`);
