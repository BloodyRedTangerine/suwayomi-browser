// Guest-JVM regression probes. `runRegression(runtime)` drives an ExtensionRuntime (the real WebAssembly VM and host JAR
// of whichever package serves it); it needs no network and no sources. Also executed inside the exact Firefox package by
// package-gate-firefox.mjs. Keep this file free of imports so it can be evaluated as a plain script.
export async function runRegression(runtime) {
  const steps = {};
  let runtimeResources;
  const expect = (condition, message) => { if (!condition) throw new Error(message); };
  async function step(name, run) {
    const started = performance.now();
    try { steps[name] = { pass: true, detail: String(await run()).slice(0, 300), ms: Math.round(performance.now() - started) }; }
    catch (error) { steps[name] = { pass: false, error: String(error?.message || error).slice(0, 600), ms: Math.round(performance.now() - started) }; }
  }
  await step('vm-start-and-host-smoke', async () => { const text = await runtime.smoke(); expect(typeof text === 'string' && text.length > 0, 'empty smoke result'); return text; });
  await step('jre-resources', async () => {
    runtimeResources = await runtime.request('runtime-resources-probe');
    expect(runtimeResources?.moduleImagePresent === true, 'module image missing');
    for (const key of ['classResource','moduleResource','moduleLayer','jrt','normalization','zoneData'])
      expect(runtimeResources[key]?.startsWith('ok:'), key + ': ' + runtimeResources[key]);
    expect(runtimeResources.normalization === 'ok:é', 'JDK normalization changed');
    expect(runtimeResources.zoneData === 'ok:+09:00', 'JDK time-zone data changed');
    return JSON.stringify(runtimeResources);
  });
  // Exception handling: catches in child-loader classes, native exceptions and GC-rooted pending exceptions.
  await step('exception-handling', async () => {
    const actual = await runtime.request('exception-handling-probe');
    expect(actual === 'throwable=0;exception=0;runtime=0;exact=0;nativeThrow=0;nested=0;inlineCatch=0', 'unexpected result: ' + actual);
    return actual;
  });
  // Locale data: localized month parsing needs the CLDR data bundled with the JRE class libraries (jdk.localedata).
  await step('locale-data', async () => {
    const text = await runtime.request('locale-data-smoke');
    for (const language of ['es=', 'zh=', 'tr=']) expect(text.includes(language), 'missing ' + language + ' in ' + text);
    return text;
  });
  await step('utf16-string-bridge', async () => {
    const cases = ['', 'Café 日本語 😀', '\0middle\0end', '﻿bom', '\ud800', '\udfff'];
    for (const value of cases) expect(await runtime.request('string-echo', { value }) === value, 'echo mismatch for ' + JSON.stringify(value));
    return cases.length + ' cases';
  });
  await step('binary-io', async () => { expect(await runtime.request('io-smoke') === 'Binary file read verified', 'binary read regression'); return 'ok'; });
  await step('source-controls', async () => { expect(await runtime.request('source-controls-smoke') === 'Filter and preference compatibility probes passed', 'source control regression'); return 'ok'; });
  await step('android-api', () => runtime.request('android-api-smoke'));
  await step('graphics', () => runtime.request('graphics-smoke'));
  await step('reference-semantics', () => runtime.request('reference-smoke'));
  await step('zstd-native', async () => `${await runtime.request('zstd-smoke')}; ${await runtime.request('zstd-safety-smoke')}`);
  await step('cookie-store', () => runtime.request('webkit-cookie-smoke'));
  return { pass: Object.values(steps).every(item => item.pass), steps, runtimeResources };
}
