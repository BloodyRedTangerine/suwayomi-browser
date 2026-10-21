// Bundles the small pure-JavaScript vendor modules that the Node tests import (vendor/fflate.mjs).
// No network, no JVM, no WASM: `npm test` runs this automatically (pretest).
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
await build({ entryPoints: [resolve(root, 'node_modules/fflate/esm/browser.js')], bundle: true, format: 'esm', outfile: resolve(root, 'vendor/fflate.mjs'), logLevel: 'warning' });
