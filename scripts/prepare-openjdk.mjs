// Build-time only. End users receive Java class libraries, not a native JVM.
import { mkdir, readFile, writeFile, readdir, cp, access } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { root, cacheRoot as cache, upstream, sourceDateEpoch } from './paths.mjs';
import { createZip } from './deterministic-zip.mjs';

const { version, url, sha256 } = upstream.corretto;
// Base language tags: every language that Mihon/Tachiyomi-style source indexes publish
// (a snapshot of a large public index was used to compile this list).
// Regional variants are covered by their base language; `all` is a catalog
// catch-all, not a locale.
const includeLocales = `
ab af am ar as az be bg bho bn bo br bs ca ceb cnr co cs cv cy da de doi dv
ee el en eo es et eu fa fi fil fo fr ga gl gn gu ha haw he hi hmn hr ht hu
hy id ig ilo is it ja jv ka kk km kn ko kok ku ky la lb lg lmo ln lo lt lus
lv mai mg mi mk ml mn mni mo mr ms mt mww my ne nl no nso ny or other pa pl
ps pt qu rm ro ru rw sa sd sh si sk sl sm sn so sq sr ss st sv sw ta te tg
th ti tk tl to tr ts uk ur uz vec vi xh yi yo zh zu
`.trim().split(/\s+/).join(',');
const jdk = process.argv[2] || resolve(cache, 'corretto-' + version);
const jre = process.argv[3] || resolve(cache, 'jre-' + version);
const classes = process.argv[4] || resolve(cache, 'classes-' + version);
async function exists(path) { try { await access(path); return true; } catch { return false; } }
const run = (command, args) => execFileSync(command, args, { stdio: 'inherit' });
await mkdir(cache, { recursive: true });
if (!await exists(join(jdk, 'release'))) {
  if (process.platform !== 'linux' || process.arch !== 'x64') throw new Error('This reproducible runtime builder currently targets Linux x64 build machines.');
  const archive = resolve(cache, 'corretto-' + version + '.tar.gz');
  if (!await exists(archive)) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('Corretto download failed: ' + response.status);
    await writeFile(archive, new Uint8Array(await response.arrayBuffer()));
  }
  const digest = createHash('sha256').update(await readFile(archive)).digest('hex');
  if (digest !== sha256) throw new Error('Corretto archive checksum mismatch');
  await mkdir(jdk, { recursive: true });
  run('tar', ['-xzf', archive, '-C', jdk, '--strip-components=1']);
}
if (!(await readFile(join(jdk, 'release'), 'utf8')).includes('JAVA_VERSION="23.0.2"')) throw new Error('Expected the pinned Java 23.0.2 class libraries');
if (!await exists(join(jre, 'lib/modules'))) run(join(jdk, 'bin/jlink'), [
  '--add-modules', 'java.base,java.logging,java.xml,java.desktop,java.naming,java.management,jdk.unsupported,jdk.crypto.ec,jdk.zipfs,jdk.localedata',
  '--include-locales', includeLocales,
  '--strip-debug', '--no-header-files', '--no-man-pages', '--compress=zip-6', '--output', jre,
]);
if (!await exists(join(classes, 'java.base/java/lang/Object.class'))) run(join(jdk, 'bin/jimage'), ['extract', '--dir', classes, join(jre, 'lib/modules')]);
const files = {};
async function collect(directory, prefix = '') {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const name = prefix + entry.name;
    if (entry.isDirectory()) await collect(join(directory, entry.name), name + '/');
    else if (name !== 'module-info.class') {
      const bytes = new Uint8Array(await readFile(join(directory, entry.name)));
      if (files[name] && Buffer.compare(files[name], bytes)) throw new Error('Runtime resource collision: ' + name);
      files[name] = bytes;
    }
  }
}
for (const module of await readdir(classes)) await collect(join(classes, module));
// The browser JVM flattens JDK modules onto the bootstrap class path, so it
// cannot use jdk.localedata's module-only provider declaration. Route CLDR
// bundle lookup through the small bootstrap provider bundled with the host.
files['META-INF/services/sun.util.resources.LocaleData$CommonResourceBundleProvider'] = new TextEncoder().encode(
  'sun.util.resources.BrowserLocaleDataProvider\n',
);
const target = resolve(root, 'vendor/bjvm/jre');
await mkdir(join(target, 'jdk23/lib/security'), { recursive: true });
// Sorted entries, one fixed timestamp (SOURCE_DATE_EPOCH), no extra attributes: the archive is byte-reproducible.
await writeFile(join(target, 'jdk23.jar'), createZip(Object.entries(files).map(([name, data]) => ({ name, data })), { epochSeconds: sourceDateEpoch, level: 6 }));
await cp(join(jre, 'conf'), join(target, 'jdk23/conf'), { recursive: true, dereference: true });
await cp(join(jre, 'legal'), join(target, 'legal'), { recursive: true, dereference: true });
// jlink emits notices for linked modules, but the locale-data legal bundle
// is omitted from some builds; preserve the pinned JDK's CLDR notices too.
await cp(join(jdk, 'legal/jdk.localedata'), join(target, 'legal/jdk.localedata'), { recursive: true, dereference: true });
for (const name of ['modules', 'tzdb.dat', 'security/default.policy', 'security/cacerts']) await cp(join(jre, 'lib', name), join(target, 'jdk23/lib', name), { dereference: true });
await writeFile(join(target, 'PROVENANCE.json'), JSON.stringify({ distribution: 'Amazon Corretto / OpenJDK', version, url, sha256, source: 'https://github.com/corretto/corretto-23/tree/23.0.2.7.1', license: 'GPL-2.0 with Classpath Exception; see legal/' }, null, 2));
console.log('Prepared pinned OpenJDK class libraries, runtime resources and license notices.');
