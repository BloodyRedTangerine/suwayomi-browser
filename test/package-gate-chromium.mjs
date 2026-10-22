// Loads an exact Chrome/Edge package (unpacked folder) in a throw-away profile launched from the shell and runs the same
// release gate as package-gate-firefox.mjs: manifest identity, launcher without duplicate tab, WebAssembly-JVM regression
// suite inside the package, About screen, synthetic library. Network goes to a dead proxy: nothing live is contacted.
// Usage: node test/package-gate-chromium.mjs <unpacked-package-dir> [report.json]
// Optional: BROWSER_BIN (default /usr/bin/microsoft-edge), GATE_PORT (default 9271), GATE_HEADED=1 (visible window),
// EXPECTED_ID (default: the pinned Chrome ID). Use TMPDIR for the profile.
import { createWriteStream } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const packagePath = resolve(process.argv[2] || '');
const reportPath = process.argv[3] && resolve(process.argv[3]);
const binary = process.env.BROWSER_BIN || '/usr/bin/microsoft-edge';
const port = Number(process.env.GATE_PORT || 9271);
const expectedId = process.env.EXPECTED_ID || 'jcjicocbfnajldjccnfnglphngckjkfn';
const regressionSource = (await readFile(fileURLToPath(new URL('./runtime-regression-steps.mjs', import.meta.url)), 'utf8')).replace('export async function runRegression', 'async function runRegression');
const root = await mkdtemp(join(process.env.TMPDIR || tmpdir(), 'package-gate-chromium-'));
const log = createWriteStream(join(root, 'browser.log'));
const report = { packagePath, checks: [], pass: false };
const wait = ms => new Promise(done => setTimeout(done, ms));
const check = (name, detail) => { report.checks.push({ name, pass: true, ...detail }); console.log('PASS ' + name); };

class Cdp {
  constructor(url) { this.ws = new WebSocket(url); this.id = 0; this.pending = new Map(); }
  async open() {
    await new Promise((resolveOpen, reject) => { this.ws.addEventListener('open', resolveOpen, { once: true }); this.ws.addEventListener('error', reject, { once: true }); });
    this.ws.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)); const pending = this.pending.get(message.id);
      if (message.method === 'Runtime.exceptionThrown' || message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        (report.consoleErrors ||= []).push(message.params);
      }
      if (!pending) return;
      this.pending.delete(message.id); clearTimeout(pending.timer);
      message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result || {});
    });
  }
  send(method, params = {}, sessionId, timeout = 60000) {
    const id = ++this.id;
    return new Promise((resolveSend, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, timeout);
      this.pending.set(id, { resolve: resolveSend, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async page(url) {
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Page.enable', {}, sessionId);
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, sessionId);
    await this.send('Page.navigate', { url }, sessionId);
    await this.send('Target.activateTarget', { targetId });
    await this.send('Page.bringToFront', {}, sessionId);
    return { targetId, sessionId };
  }
  async evaluate(sessionId, expression, timeout = 60000) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId, timeout);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result?.value;
  }
  close() { for (const pending of this.pending.values()) clearTimeout(pending.timer); this.ws.close(); }
}

let browser, cdp;
try {
  const manifest = JSON.parse(await readFile(join(packagePath, 'manifest.json'), 'utf8'));
  const problems = [];
  if (!manifest.key) problems.push('manifest key missing');
  if (manifest.host_permissions?.length) problems.push('host_permissions present');
  if (manifest.browser_specific_settings) problems.push('Firefox-only settings in the Chromium manifest');
  if (problems.length) throw new Error('Chromium manifest: ' + problems.join(', '));
  report.version = manifest.version;
  const args = [...(process.env.GATE_HEADED ? [] : ['--headless=new']), '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--enable-unsafe-extension-debugging',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--disable-background-networking', '--disable-component-update',
    `--remote-debugging-port=${port}`, `--user-data-dir=${join(root, 'profile')}`, `--load-extension=${packagePath}`, 'about:blank'];
  browser = spawn(binary, args, { env: { ...process.env, TMPDIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  browser.stdout.pipe(log); browser.stderr.pipe(log);
  for (let index = 0; index < 200 && !report.browser; index++) {
    try { const response = await fetch(`http://127.0.0.1:${port}/json/version`); if (response.ok) report.browser = (await response.json()); } catch {}
    if (browser.exitCode !== null) throw new Error('Browser exited ' + browser.exitCode);
    await wait(100);
  }
  if (!report.browser) throw new Error('Browser did not expose DevTools');
  cdp = new Cdp(report.browser.webSocketDebuggerUrl); await cdp.open();
  const base = `chrome-extension://${expectedId}/`;
  const { sessionId } = await cdp.page(base + 'recovery.html');
  let identity;
  for (let index = 0; index < 100 && !identity; index++) { try { identity = await cdp.evaluate(sessionId, 'chrome.runtime.id'); } catch { await wait(200); } }
  if (identity !== expectedId) throw new Error('Unexpected extension id ' + identity);
  const grants = await cdp.evaluate(sessionId, 'chrome.permissions.getAll()');
  if (grants.origins?.length) throw new Error('Host permissions granted at install: ' + grants.origins);
  check('pinned extension ID, no host permissions granted, manifest key present', { id: identity, version: manifest.version });
  // A fresh install opens a WebUI tab. Close it before the out-of-band seed
  // so an already-mounted backend cannot race this isolated test database.
  report.closedFirstRunTabs = await cdp.evaluate(sessionId, '(async()=>{const prefix=chrome.runtime.getURL("ui/");const ids=(await chrome.tabs.query({})).filter(tab=>tab.url?.startsWith(prefix)).map(tab=>tab.id);if(ids.length)await chrome.tabs.remove(ids);return ids.length})()');

  const regression = await cdp.evaluate(sessionId, `(async()=>{
    ${regressionSource}
    const { ExtensionRuntime } = await import(chrome.runtime.getURL('src/extensions/runtime.mjs'));
    const runtime = new ExtensionRuntime({ transport: async () => { throw new Error('Network disabled in the gate'); } });
    try { return await runRegression(runtime); } finally { runtime.dispose(); }
  })()`, 600000);
  report.regression = regression;
  if (!regression.pass) throw new Error('WebAssembly JVM regression failed: ' + JSON.stringify(regression).slice(0, 2000));
  check('WebAssembly JVM regression suite passes in the package', { steps: Object.keys(regression.steps) });

  report.closedFirstRunTabs += await cdp.evaluate(sessionId, '(async()=>{const prefix=chrome.runtime.getURL("ui/");const ids=(await chrome.tabs.query({})).filter(tab=>tab.url?.startsWith(prefix)).map(tab=>tab.id);if(ids.length)await chrome.tabs.remove(ids);return ids.length})()');

  const seeded = await cdp.evaluate(sessionId, `(async()=>{
    const {IndexedDbStore}=await import(chrome.runtime.getURL('src/core.mjs'));
    const {BrowserBackend}=await import(chrome.runtime.getURL('src/webui/backend.mjs'));
    const backend=new BrowserBackend(new IndexedDbStore(),{manager:{list:async()=>[],sources:async()=>[]},autoDownloads:false,autoUpdates:false});
    await backend.loading;
    const rows=['Alpha','Beta'].map(name=>backend.rememberManga('fixture',{title:'Sample Series '+name,url:'/sample-'+name.toLowerCase(),author:'Sample Author',description:'Synthetic library preview',genre:[],thumbnailUrl:'synthetic:'+name}));
    for(const row of rows){row.inLibrary=true;Object.assign(row,{initialized:true,lastFetchedAt:Date.now(),chaptersLastFetchedAt:Date.now(),genre:[],browserGenreRaw:''});}
    await backend.rememberChapters(rows[0],[{url:'/sample-chapter-1',name:'Sample Chapter 1',number:1,dateUpload:Date.now()}]);
    await backend.save();backend.dispose();return rows.length;
  })()`);
  if (seeded !== 2) throw new Error('Synthetic seed failed');
  const ui = await cdp.page(base + 'ui/index.html#/library');
  let text = '';
  for (let index = 0; index < 300 && !text.includes('Sample Series Alpha'); index++) {
    text = await cdp.evaluate(ui.sessionId, 'document.body?.innerText||""');
    // Explicit viewport resize wakes virtual-list measurements in isolated
    // Chromium windows with no compositor-driven desktop resize event.
    if (index === 30) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1279, height: 899, deviceScaleFactor: 1, mobile: false }, ui.sessionId);
      await wait(100);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false }, ui.sessionId);
    }
    await wait(100);
  }
  report.libraryDiagnostics = await cdp.evaluate(ui.sessionId, '(async()=>{const {IndexedDbStore}=await import(chrome.runtime.getURL("src/core.mjs"));return {innerText:document.body.innerText,textContent:document.body.textContent,width:innerWidth,height:innerHeight,html:document.querySelector("main")?.innerHTML,url:location.href,stored:await new IndexedDbStore().get("settings","webui:database")}})()');
  if (!text.includes('Sample Series Alpha') || !text.includes('Sample Series Beta')) throw new Error('Synthetic library did not render');
  check('official WebUI renders the synthetic library', { entries: 2 });

  const about = await cdp.page(base + 'ui/index.html#/about');
  let aboutText = '';
  for (let index = 0; index < 300 && !aboutText.includes(manifest.version); index++) { aboutText = await cdp.evaluate(about.sessionId, 'document.body?.innerText||""'); await wait(100); }
  if (!aboutText.includes(manifest.version)) throw new Error('About screen does not show version ' + manifest.version);
  check('About screen opens and shows the packaged version', { version: manifest.version });

  // launcher: with an open WebUI tab it focuses it and closes itself, no duplicate
  await cdp.evaluate(ui.sessionId, 'chrome.runtime.sendMessage({type:"suwayomi:register-app-tab"}).then(()=>true)');
  const tabCount = async () => (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).filter(target => target.type === 'page' && target.url.startsWith(base)).length;
  const before = await tabCount();
  const launcher = await cdp.page(base + 'launcher.html');
  let after = before + 1;
  for (let index = 0; index < 100 && after > before; index++) { await wait(100); after = await tabCount(); }
  if (after !== before) throw new Error(`Launcher left ${after} extension tabs (expected ${before}); duplicate WebUI tab`);
  check('launcher focuses the existing WebUI tab without opening a duplicate', { extensionTabsBefore: before, extensionTabsAfter: after, launcherTarget: launcher.targetId });
  report.pass = true;
} catch (error) {
  report.error = String(error?.stack || error); process.exitCode = 1; console.error('FAIL ' + report.error);
} finally {
  if (cdp) { try { await cdp.send('Browser.close', {}, undefined, 5000); } catch {} cdp.close(); }
  if (browser && browser.exitCode === null) browser.kill('SIGTERM');
  await new Promise(done => log.end(done));
  if (reportPath) await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(report.pass ? 'GATE PASSED' : 'GATE FAILED');
  await rm(root, { recursive: true, force: true }).catch(() => {});
}
