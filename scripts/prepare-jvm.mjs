import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { root } from './paths.mjs';

// Run after `build:vm` (which provides vendor/bjvm/LICENSE from the pinned b-jvm checkout) and prepare-openjdk.mjs.
await access(resolve(root, 'vendor/bjvm/LICENSE')).catch(() => { throw new Error('Run `npm run build:vm` first: it copies the VM licence from the pinned checkout.'); });
await readFile(resolve(root, 'vendor/bjvm/jre/PROVENANCE.json')).catch(() => { throw new Error('Run scripts/prepare-openjdk.mjs before preparing the JVM wrapper.'); });
const common = { bundle: true, absWorkingDir: root, metafile: true, logLevel: 'warning' };
const modules = new Set();
const record = result => { for (const input of Object.keys(result.metafile.inputs)) if (input.startsWith('node_modules/')) modules.add(input); };
// Bundle the upstream TypeScript wrapper without changing the VM implementation.
record(await build({ ...common, entryPoints: [resolve(root, 'src/jvm/bjvm.ts')], format: 'esm', target: 'es2022', outfile: resolve(root, 'vendor/bjvm/bjvm.mjs') }));
record(await build({ ...common, entryPoints: [resolve(root, 'node_modules/fflate/esm/browser.js')], format: 'esm', outfile: resolve(root, 'vendor/fflate.mjs') }));
record(await build({ ...common, entryPoints: [resolve(root, 'src/extensions/quickjs.mjs')], platform: 'browser', format: 'esm', outfile: resolve(root, 'vendor/quickjs.mjs') }));
const wasm = 'node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm';
await writeFile(resolve(root, 'vendor/quickjs.wasm'), await readFile(resolve(root, wasm)));
modules.add(wasm);
// Which npm packages ended up in the shipped JavaScript: consumed by package-extension.mjs for licence texts.
await mkdir(resolve(root, 'vendor'), { recursive: true });
await writeFile(resolve(root, 'vendor/js-modules.json'), JSON.stringify([...modules].sort(), null, 2) + '\n');
