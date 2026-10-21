import { execFileSync } from 'node:child_process';
import { mkdir, access, cp, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { root, cacheRoot, upstream } from './paths.mjs';

const revision = upstream.webui.revision;
const source = resolve(process.env.SUWAYOMI_WEBUI_SOURCE || join(cacheRoot, 'webui'));
const patch = resolve(root, upstream.webui.localPatch);
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: source, stdio: 'inherit', ...options });
const output = args => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
try { await access(join(source, '.git')); }
catch {
  await mkdir(source, { recursive: true });
  run('git', ['init']);
  run('git', ['remote', 'add', 'origin', upstream.webui.repository + '.git']);
  run('git', ['fetch', '--depth', '1', 'origin', revision]);
  run('git', ['checkout', '--detach', 'FETCH_HEAD']);
}
if (output(['rev-parse', 'HEAD']) !== revision) throw new Error('WebUI source is not at the pinned revision; existing checkout was not changed.');
try { run('git', ['apply', '--reverse', '--check', patch], { stdio: 'pipe' }); }
catch {
  if (output(['status', '--porcelain'])) throw new Error('WebUI source has other changes; refusing to overwrite them.');
  run('git', ['apply', '--check', patch]);
  run('git', ['apply', patch]);
}
// Release-build edit that is applied by code rather than by the patch: the upstream WebUI contains a heuristic list of
// third-party site names (used to guess an entry's type from its source name). This build does not ship third-party site
// names; the same detection from genres/tags is unchanged. The edit fails loudly if upstream changes the shape.
// It modifies the WebUI checkout, so it only runs for release builds (BROWSER_RELEASE_EDITS=1, set by docker/build.sh).
if (process.env.BROWSER_RELEASE_EDITS === '1') {
  const file = join(source, 'src/features/manga/Manga.constants.ts');
  const text = await readFile(file, 'utf8');
  const pattern = /export const SOURCES_BY_MANGA_TYPE: Record<MangaType, string\[\]> = \{[\s\S]*?\n\};\n/;
  if (!pattern.test(text)) throw new Error('SOURCES_BY_MANGA_TYPE was not found in the pinned WebUI; review the release-build edit.');
  const emptied = ['MANGA', 'COMIC', 'WEBTOON', 'MANHWA', 'MANHUA'].map(name => `    [MangaType.${name}]: [],`).join('\n');
  await writeFile(file, text.replace(pattern, `// Source-name based type detection is empty in this build (see scripts/build-webui.mjs); genre/tag detection is unchanged.\nexport const SOURCES_BY_MANGA_TYPE: Record<MangaType, string[]> = {\n${emptied}\n};\n`));
}
run('pnpm', ['install', '--frozen-lockfile']);
// The module list written by the build (see the patched vite.config.ts) drives the licence collection in package-extension.mjs.
const moduleList = resolve(root, 'vendor/webui-modules.json');
await mkdir(resolve(root, 'vendor'), { recursive: true });
await rm(moduleList, { force: true });
run('pnpm', ['exec', 'vite', 'build'], { env: { ...process.env, VITE_BROWSER_LOCAL: 'true', VITE_BROWSER_LOCAL_TEST: 'false', VITE_BROWSER_LOCAL_OFFLINE_TEST: 'false', VITE_BROWSER_LOCAL_TEST_SOURCE: '', BROWSER_SOURCE_DIR: resolve(root, 'src'), BROWSER_MODULE_LIST: moduleList } });
await access(moduleList);
// Stage next to the destination (never across mount points), then replace the generated build.
const staged = resolve(root, 'ui-stage');
await rm(staged, { recursive: true, force: true });
await cp(join(source, 'build'), staged, { recursive: true });
await cp(join(source, 'LICENSE'), join(staged, 'LICENSE-MPL-2.0'));
await writeFile(join(staged, 'UPSTREAM.json'), JSON.stringify({ repository: upstream.webui.repository, revision, localPatch: upstream.webui.localPatch, syntheticSources: false, offlineTest: false }, null, 2));
const target = resolve(root, 'ui');
let existing = false;
try { await access(target); existing = true; } catch {}
if (existing) {
  await readFile(join(target, 'UPSTREAM.json')).catch(() => { throw new Error('Existing ui/ is not a marked generated build; refusing to replace it.'); });
  await rm(target, { recursive: true });
}
await cp(staged, target, { recursive: true });
await rm(staged, { recursive: true });
// Release hygiene: no source maps, no machine paths in the shipped frontend.
const { readdir } = await import('node:fs/promises');
async function* walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) yield* walk(path); else yield path;
  }
}
const leakNeedles = [source, root, process.env.HOME].filter(value => value && value.length > 3 && value !== '/');
for await (const path of walk(target)) {
  if (path.endsWith('.map')) throw new Error('Source map in the production WebUI: ' + path);
  if (/\.(?:m?js|css|html|json)$/.test(path)) {
    const text = await readFile(path, 'utf8');
    for (const needle of leakNeedles) if (text.includes(needle)) throw new Error(`${path} contains the build path ${needle}`);
  }
}
console.log('Built the official Suwayomi-WebUI with the local browser transport.');
