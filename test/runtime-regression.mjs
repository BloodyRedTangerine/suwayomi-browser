// Page driver for runtime-regression-steps.mjs. Results: globalThis.__runtimeRegression = { pass, steps }.
const sourceRoot = location.pathname.includes('/SOURCE/') ? '../../src' : '../src';
const { ExtensionRuntime } = await import(new URL(`${sourceRoot}/extensions/runtime.mjs`, import.meta.url));
const { runRegression } = await import('./runtime-regression-steps.mjs');
const runtime = new ExtensionRuntime({ transport: async () => { throw new Error('Network disabled in the synthetic regression suite'); } });
try { globalThis.__runtimeRegression = await runRegression(runtime); }
catch (error) { globalThis.__runtimeRegression = { pass: false, error: String(error?.message || error) }; }
finally { runtime.dispose(); }
document.querySelector('#result').textContent = (globalThis.__runtimeRegression.pass ? 'ALL PASSED\n' : 'FAILED\n') + JSON.stringify(globalThis.__runtimeRegression, null, 2);
globalThis.__runtimeRegressionDone = true;
