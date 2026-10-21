// Loads an exact Firefox package (ZIP or unpacked folder) in a throw-away profile and runs the release gate:
//   1. manifest identity and permissions as loaded by the browser,
//   2. the launcher opens the WebUI without a duplicate tab,
//   3. the WebAssembly-JVM regression suite (exception handling, locale data, strings, graphics, zstd, ...) inside the package,
//   4. the About screen shows the packaged version,
//   5. a synthetic library renders.
// No source or repository is configured and all browser traffic is sent to a dead proxy, so nothing live can be contacted.
// Usage: GECKODRIVER=/path/to/geckodriver node test/package-gate-firefox.mjs <package.zip|dir> [report.json]
// Optional: FIREFOX_BIN (default firefox), GATE_PORT (default 4469), GATE_SCREENSHOTS=<dir>. Use TMPDIR for the profile.
import { createWriteStream } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packagePath = resolve(process.argv[2] || '');
const reportPath = process.argv[3] && resolve(process.argv[3]);
const geckodriver = process.env.GECKODRIVER || 'geckodriver';
const firefox = process.env.FIREFOX_BIN || 'firefox';
const port = Number(process.env.GATE_PORT || 4469);
const base = `http://127.0.0.1:${port}`;
const regressionSource = (await readFile(fileURLToPath(new URL('./runtime-regression-steps.mjs', import.meta.url)), 'utf8')).replace('export async function runRegression', 'async function runRegression');
const profileRoot = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'package-gate-'));
const log = createWriteStream(join(profileRoot, 'driver.log'));
const report = { packagePath, checks: [], pass: false };
let driver, session;
const wait = ms => new Promise(done => setTimeout(done, ms));
async function command(method, path, body) {
  const response = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  if (!response.ok || result.value?.error) throw new Error(JSON.stringify(result.value));
  return result.value;
}
const execute = script => command('POST', `/session/${session}/execute/sync`, { script, args: [] });
const executeAsync = script => command('POST', `/session/${session}/execute/async`, { script, args: [] });
const go = url => command('POST', `/session/${session}/url`, { url });
async function until(test, label, rounds = 300) {
  for (let index = 0; index < rounds; index++) { const value = await test(); if (value) return value; await wait(100); }
  throw new Error('Timed out waiting for ' + label);
}
const check = (name, detail) => { report.checks.push({ name, pass: true, ...detail }); console.log('PASS ' + name); };

try {
  driver = spawn(geckodriver, ['--port', String(port), '--profile-root', profileRoot, '--allow-system-access'], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMPDIR: profileRoot } });
  driver.stdout.pipe(log); driver.stderr.pipe(log);
  await until(async () => { try { return (await fetch(base + '/status')).ok; } catch { return false; } }, 'geckodriver', 100);
  const created = await command('POST', '/session', { capabilities: { alwaysMatch: { browserName: 'firefox', 'moz:firefoxOptions': {
    binary: firefox, args: ['-headless'],
    prefs: { 'intl.locale.requested': 'en-US', 'network.proxy.type': 1, 'network.proxy.http': '127.0.0.1', 'network.proxy.http_port': 9, 'network.proxy.ssl': '127.0.0.1', 'network.proxy.ssl_port': 9,
      'network.proxy.no_proxies_on': '', 'app.update.enabled': false, 'datareporting.healthreport.uploadEnabled': false, 'toolkit.telemetry.enabled': false },
  } } } });
  session = created.sessionId;
  report.firefoxVersion = created.capabilities.browserVersion;
  await command('POST', `/session/${session}/timeouts`, { script: 600000, pageLoad: 60000 });
  await command('POST', `/session/${session}/moz/addon/install`, { path: packagePath, temporary: true });
  await command('POST', `/session/${session}/moz/context`, { context: 'chrome' });
  const host = await execute("return WebExtensionPolicy.getByID('suwayomi-browser@bloodyredtangerine').mozExtensionHostname");
  await command('POST', `/session/${session}/moz/context`, { context: 'content' });
  const extensionUrl = path => `moz-extension://${host}/${path}`;

  // 1. identity and permissions as loaded
  await go(extensionUrl('recovery.html'));
  const loaded = await execute('return {manifest: chrome.runtime.getManifest(), id: chrome.runtime.id}');
  const manifest = loaded.manifest;
  const problems = [];
  if (loaded.id !== 'suwayomi-browser@bloodyredtangerine') problems.push('id ' + loaded.id);
  if (manifest.host_permissions?.length) problems.push('host_permissions present');
  if (manifest.key) problems.push('key present');
  if (!manifest.browser_specific_settings?.gecko_android) problems.push('gecko_android missing');
  const collection = manifest.browser_specific_settings?.gecko?.data_collection_permissions; // normalised by Firefox
  if (JSON.stringify(collection?.required) !== '["none"]' || collection?.optional?.length) problems.push('data_collection_permissions');
  if (problems.length) throw new Error('Manifest as loaded: ' + problems.join(', '));
  const granted = await executeAsync('const done=arguments[arguments.length-1];chrome.permissions.getAll().then(done);');
  if (granted.origins?.length) throw new Error('Host permissions granted at install: ' + granted.origins);
  report.version = manifest.version;
  check('manifest identity, no host permissions granted, no key, data collection none', { version: manifest.version, permissions: manifest.permissions, optional_host_permissions: manifest.optional_host_permissions });

  // 2. WebAssembly JVM regression suite inside the package
  const regression = await executeAsync(`const done=arguments[arguments.length-1];(async()=>{
    ${regressionSource}
    const { ExtensionRuntime } = await import(chrome.runtime.getURL('src/extensions/runtime.mjs'));
    const runtime = new ExtensionRuntime({ transport: async () => { throw new Error('Network disabled in the gate'); } });
    try { return await runRegression(runtime); } finally { runtime.dispose(); }
  })().then(done, error => done({ pass: false, error: String(error && error.message || error) }));`);
  report.regression = regression;
  if (!regression.pass) throw new Error('WebAssembly JVM regression failed: ' + JSON.stringify(regression).slice(0, 2000));
  check('WebAssembly JVM regression suite passes in the package (exception handling, locale data, strings, graphics, zstd, cookies, ...)', { steps: Object.keys(regression.steps) });

  // 3. synthetic library renders
  const seeded = await executeAsync(`const done=arguments[arguments.length-1];(async()=>{
    const {IndexedDbStore}=await import(chrome.runtime.getURL('src/core.mjs'));
    const {BrowserBackend}=await import(chrome.runtime.getURL('src/webui/backend.mjs'));
    const backend=new BrowserBackend(new IndexedDbStore(),{manager:{list:async()=>[],sources:async()=>[]},autoDownloads:false,autoUpdates:false});
    await backend.loading;
    const rows=['Alpha','Beta'].map(name=>backend.rememberManga('fixture',{title:'Sample Series '+name,url:'/sample-'+name.toLowerCase(),author:'Sample Author',description:'Synthetic library preview',genre:[],thumbnailUrl:'synthetic:'+name}));
    for(const row of rows){row.inLibrary=true;Object.assign(row,{initialized:true,lastFetchedAt:Date.now(),chaptersLastFetchedAt:Date.now(),genre:[],browserGenreRaw:''});}
    await backend.rememberChapters(rows[0],[{url:'/sample-chapter-1',name:'Sample Chapter 1',number:1,dateUpload:Date.now()}]);
    await backend.save();backend.dispose();return {count:rows.length,ids:rows.map(row=>row.id)};
  })().then(done,error=>done({error:String(error)}));`);
  if (seeded?.error) throw new Error('Synthetic seed failed: ' + seeded.error);
  await go(extensionUrl('ui/index.html#/library'));
  await until(async () => (await execute('return document.body?.innerText||""')).includes('Sample Series Alpha'), 'synthetic library entry');
  const libraryText = await execute('return document.body.innerText');
  if (!libraryText.includes('Sample Series Beta')) throw new Error('Second synthetic entry missing');
  check('official WebUI renders the synthetic library from the browser-local backend', { entries: 2 });
  if (process.env.GATE_SCREENSHOTS) {
    await mkdir(process.env.GATE_SCREENSHOTS, { recursive: true });
    await writeFile(join(process.env.GATE_SCREENSHOTS, 'library.png'), Buffer.from(await command('GET', `/session/${session}/screenshot`), 'base64'));
  }

  // 4. About screen
  await go(extensionUrl('ui/index.html#/about'));
  await until(async () => (await execute('return document.body?.innerText||""')).includes(manifest.version), 'About screen showing the packaged version');
  const aboutText = await execute('return document.body.innerText');
  check('About screen opens and shows the packaged version', { version: manifest.version, hasDiagnosticsButton: /Copy diagnostics/i.test(aboutText) });

  // 5. launcher opens the existing WebUI tab, no duplicate
  await go(extensionUrl('ui/index.html#/library'));
  await executeAsync('const done=arguments[arguments.length-1];chrome.runtime.sendMessage({type:"suwayomi:register-app-tab"}).then(done);');
  const tabIds = () => executeAsync('const done=arguments[arguments.length-1];chrome.tabs.query({}).then(tabs=>done(tabs.map(tab=>tab.id)));');
  const before = await tabIds();
  const opened = await executeAsync('const done=arguments[arguments.length-1];chrome.tabs.create({url:chrome.runtime.getURL("launcher.html")}).then(tab=>done({id:tab.id}),error=>done({error:String(error)}));');
  if (opened?.error) throw new Error('Cannot open the launcher: ' + opened.error);
  const after = await until(async () => { const ids = await tabIds(); return ids.length === before.length && !ids.includes(opened.id) && ids.length ? ids : null; }, 'launcher closes after focusing the WebUI');
  check('launcher focuses the existing WebUI tab without opening a duplicate', { tabsBefore: before.length, tabsAfter: after.length });

  report.pass = true;
} catch (error) {
  report.error = String(error?.stack || error);
  process.exitCode = 1;
  console.error('FAIL ' + report.error);
} finally {
  if (session) try { await command('DELETE', `/session/${session}`); } catch {}
  if (driver && driver.exitCode === null) driver.kill('SIGTERM');
  await new Promise(done => log.end(done));
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(report.pass ? 'GATE PASSED' : 'GATE FAILED');
  await rm(profileRoot, { recursive: true, force: true }).catch(() => {});
}
