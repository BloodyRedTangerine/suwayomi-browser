import { execFileSync } from 'node:child_process';
import { access, mkdir, cp, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build as bundle } from 'esbuild';
import { root, cacheRoot, upstream } from './paths.mjs';

const revision = upstream.vm.revision;
const source = resolve(process.env.BROWSER_VM_SOURCE || join(cacheRoot, 'b-jvm'));
const patch = resolve(root, upstream.vm.patch);
const run = (command, args, options = {}) => execFileSync(command, args, { cwd: source, stdio: 'inherit', ...options });
const output = args => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
try { await access(join(source, '.git')); }
catch {
  await mkdir(source, { recursive: true });
  run('git', ['init']);
  run('git', ['remote', 'add', 'origin', upstream.vm.repository + '.git']);
  run('git', ['fetch', '--depth', '1', 'origin', revision]);
  run('git', ['checkout', '--detach', 'FETCH_HEAD']);
}
if (output(['rev-parse', 'HEAD']) !== revision) throw new Error('VM source is not at the pinned revision; existing checkout was not changed.');
try { run('git', ['apply', '--reverse', '--check', patch], { stdio: 'pipe' }); }
catch {
  if (output(['status', '--porcelain'])) throw new Error('VM source has other changes; refusing to overwrite them.');
  run('git', ['apply', '--check', patch]);
  run('git', ['apply', patch]);
}
const cmake = process.env.CMAKE || 'cmake';
const build = process.env.BROWSER_VM_BUILD_DIR ? resolve(process.env.BROWSER_VM_BUILD_DIR) : join(source, 'browser-wasm-build');
// Keep machine-specific absolute paths out of the WASM (assertion/file-name macros in the natives) and out of the
// Emscripten glue: map the source and build trees (the Zstandard checkout lives below the build tree) to fixed names.
// The build map comes last so it wins where the build directory sits inside the source tree.
const maps = [`-ffile-prefix-map=${source}=/src/b-jvm`];
const zstdOverride = process.env.BROWSER_ZSTD_SOURCE ? resolve(process.env.BROWSER_ZSTD_SOURCE) : '';
if (zstdOverride) maps.push(`-ffile-prefix-map=${zstdOverride}=/src/zstd`);
maps.push(`-ffile-prefix-map=${build}=/build/b-jvm`);
const prefixFlags = maps.join(' ');
const configureArgs = [cmake, '-GNinja', '-S', source, '-B', build, '-DCMAKE_BUILD_TYPE=Release', '-DBUILD_TESTING=OFF', '-DCMAKE_EXPORT_COMPILE_COMMANDS=ON',
  `-DCMAKE_C_FLAGS=${prefixFlags}`, `-DCMAKE_CXX_FLAGS=${prefixFlags}`];
if (zstdOverride) configureArgs.push(`-DFETCHCONTENT_SOURCE_DIR_BROWSER_ZSTD=${zstdOverride}`);
run(process.env.EMCMAKE || 'emcmake', configureArgs);
const cache = await readFile(join(build, 'CMakeCache.txt'), 'utf8');
const override = cache.match(/^FETCHCONTENT_SOURCE_DIR_BROWSER_ZSTD:[^=]+=(.+)$/m)?.[1];
const zstd = override || join(build, '_deps/browser_zstd-src');
const zstdRevision = upstream.zstd.revision;
const actualZstdRevision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: zstd, encoding: 'utf8' }).trim();
if (actualZstdRevision !== zstdRevision) throw new Error('Zstandard checkout is not at the pinned revision');
if (execFileSync('git', ['status', '--porcelain'], { cwd: zstd, encoding: 'utf8' }).trim()) throw new Error('Zstandard checkout has unrecorded changes');
// Confirm the prefix maps reach the compile commands of both the VM natives and the Zstandard target.
const commands = JSON.parse(await readFile(join(build, 'compile_commands.json'), 'utf8').catch(() => '[]'));
if (commands.length) {
  const missing = commands.filter(item => !(item.command || item.arguments?.join(' ') || '').includes('-ffile-prefix-map='));
  if (missing.length) throw new Error(`${missing.length} compile commands lack -ffile-prefix-map`);
  if (!commands.some(item => /zstd/i.test(item.file) && (item.command || '').includes('-ffile-prefix-map=')))
    throw new Error('The Zstandard target does not receive the prefix maps');
}
run(cmake, ['--build', build, '--target', 'bjvm_main', '-j', process.env.BROWSER_BUILD_JOBS || '4']);
// Fail the build if any machine-specific path survived into the shipped VM files.
const leakChecks = [source, build, zstd, root, process.env.HOME, process.env.USER && '/home/' + process.env.USER].filter(Boolean);
for (const file of ['bjvm_main.js', 'bjvm_main.wasm']) {
  const text = (await readFile(join(build, file))).toString('latin1');
  for (const needle of leakChecks) if (needle.length > 3 && needle !== '/' && text.includes(needle)) throw new Error(`${file} contains the build-machine path ${needle}`);
  const home = /\/home\/(?!web_user\b)[A-Za-z0-9._-]+/.exec(text);
  if (home) throw new Error(`${file} contains a home-directory path (${home[0]})`);
}
await mkdir(resolve(root, 'runtime/vm'), { recursive: true });
await mkdir(resolve(root, 'vendor/bjvm'), { recursive: true });
for (const file of ['bjvm_main.js', 'bjvm_main.wasm']) await cp(join(build, file), resolve(root, 'runtime/vm', file));
for (const name of ['LICENSE', 'COPYING']) await cp(join(zstd, name), resolve(root, 'vendor/bjvm', 'ZSTD-' + name));
await cp(join(source, 'LICENSE'), resolve(root, 'vendor/bjvm/LICENSE'));
await writeFile(resolve(root, 'vendor/bjvm/ZSTD-PROVENANCE.json'), JSON.stringify({ repository: upstream.zstd.repository, revision: zstdRevision, version: upstream.zstd.version, mode: upstream.zstd.mode, squareApiRevision: upstream.zstd.squareApiRevision }, null, 2));
await bundle({ entryPoints: [resolve(root, 'src/jvm/bjvm.ts')], bundle: true, format: 'esm', target: 'es2022', outfile: resolve(root, 'vendor/bjvm/bjvm.mjs'), absWorkingDir: root, logLevel: 'warning' });
