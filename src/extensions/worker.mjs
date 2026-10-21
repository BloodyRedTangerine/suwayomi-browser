import { makeBovineOS } from '../../vendor/bjvm/bjvm.mjs';
import { evaluateScript } from '../../vendor/quickjs.mjs';
import { captureFilesystem, restoreFilesystem } from './filesystem.mjs';
import { imageOperation } from './image-codec.mjs';
import { createImageBinaryChannel } from './image-binary.mjs';
import { matchingPermissionDenials } from './permission-denial.mjs';

let os, vm, Host, Gateway, Transport, Context, controlThread, operationThread;
let startup, imageBinary;
let queue = Promise.resolve();
let jarId = 0;
let pumping = false;
let pumpEnabled = false;
let traceNative = false;
const stderr = [];
let commandPermissionDenials = [];

function progress(message) { postMessage({ type: 'progress', message }); }

async function initialize() {
  progress('Starting the local extension JVM…');
  os = await makeBovineOS({
    runtimeUrl: new URL('../../vendor/bjvm/jre', import.meta.url).href,
    wasmLocation: new URL('../../runtime/vm/bjvm_main.wasm', import.meta.url).href,
    additionalRuntimeFiles: ['jdk23/lib/tzdb.dat', 'jdk23/lib/security/cacerts', 'jdk23/conf/logging.properties', 'jdk23/conf/security/policy/unlimited/default_local.policy', 'jdk23/conf/security/policy/unlimited/default_US_export.policy'],
    stdout: bytes => { const text = new TextDecoder().decode(bytes); stderr.push(text); if (stderr.length > 60) stderr.shift(); if (traceNative) progress(text); },
    stderr: bytes => { const text = new TextDecoder().decode(bytes); stderr.push(text); if (stderr.length > 60) stderr.shift(); if (traceNative) progress(text); },
  });
  for (const dir of ['/extensions', '/cache', '/data']) os.FS.mkdir(dir);
  imageBinary = createImageBinaryChannel(os.FS);
  const response = await fetch(new URL('../../runtime/extension-host.jar', import.meta.url));
  if (!response.ok) throw new Error('Extension host JAR missing; run the browser build.');
  os.FS.writeFile('/extensions/host.jar', new Uint8Array(await response.arrayBuffer()));
  vm = os.makeVM({ classpath: '/extensions/host.jar', heapSize: 256 * 1024 * 1024 });
  operationThread = vm.getActiveThread();
  controlThread = vm.createThread();
  const System = vm.loadClass('java/lang/System');
  await System.setProperty('jdk.logger.finder.error', 'ERROR');
  await System.setProperty('suwayomi.browser.binaryImages', 'true');
  Host = vm.loadClass('suwayomi/browser/ExtensionHost');
  progress(await Host.smoke());
}

async function describe(error) {
  try {
    if (typeof error.printStackTrace === 'function') await error.printStackTrace();
    if (typeof error.getMessage === 'function') return String(await error.getMessage()) + '\n' + stderr.join('');
  } catch {}
  return error.stack || String(error) + '\n' + stderr.join('');
}

async function pump() {
  if (!Transport || !pumpEnabled || pumping) return;
  pumping = true;
  try {
    vm.setActiveThread(controlThread);
    const requests = JSON.parse(await Transport.drain()) || [];
    const network = [];
    for (const request of requests) {
      if (request.kind === 'image') {
        let response;
        try { response = await imageOperation(request, { binary: imageBinary }); } catch (error) { response = { error: error.message }; }
        vm.setActiveThread(controlThread);
        await Transport.respond(request.id, JSON.stringify(response));
        continue;
      }
      if (request.kind === 'webview') {
        postMessage({ type: 'webview', request });
        continue;
      }
      if (request.kind !== 'script') { network.push(request); continue; }
      let response;
      try { response = await evaluateScript(request); } catch (error) { response = { error: error.message }; }
      vm.setActiveThread(controlThread);
      await Transport.respond(request.id, JSON.stringify(response));
    }
    if (network.length) postMessage({ type: 'network', requests: network });
  } finally { vm.setActiveThread(operationThread); pumping = false; }
}
setInterval(() => pump().catch(error => progress('Network bridge error: ' + error)), 20);

self.onmessage = ({ data }) => {
  if (data.type === 'network-result' || data.type === 'webview-result') {
    if (data.response?.error && data.response?.deniedOrigins?.length)
      commandPermissionDenials.push({ message: data.response.error, deniedOrigins: data.response.deniedOrigins });
    vm.setActiveThread(controlThread);
    const response = Transport.respond(data.id, JSON.stringify(data.response));
    vm.setActiveThread(operationThread);
    response.catch(error => progress('Network response error: ' + error));
    return;
  }
  if (data.type !== 'command') return;
  if (data.operation === 'diagnostics') {
    let threads = '';
    if (vm?._module._ffi_debug_threads) {
      const pointer = vm._module._ffi_debug_threads(vm.ptr);
      threads = vm._module.UTF8ToString(pointer);
      vm._module._free(pointer);
    }
    postMessage({ id: data.id, result: stderr.join('').slice(-12000) + '\n' + threads });
    return;
  }
  queue = queue.then(async () => {
    commandPermissionDenials = [];
    try {
      startup ||= initialize();
      await startup;
      vm.setActiveThread(operationThread);
      let result;
      if (data.operation === 'smoke') result = await Host.smoke();
      else if (data.operation === 'string-echo') result = await Host.stringEcho(data.args.value);
      else if (data.operation === 'locale-data-smoke') result = await Host.localeDataProbe();
      else if (data.operation === 'jvm-defaults') result = JSON.parse(await Host.jvmDefaultsProbe());
      else if (data.operation === 'date-failure-probe') result = await Host.dateFailureProbe(data.args.value);
      else if (data.operation === 'exception-handling-probe') result = await Host.exceptionHandlingProbe();
      else if (data.operation === 'date-source-helper-probe') result = await Gateway.dateHelperProbe(data.args.value);
      else if (data.operation === 'verify-jar-signature') {
        const path = '/extensions/signature-' + (++jarId) + '.jar';
        os.FS.writeFile(path, data.args.bytes);
        try { result = await Host.verifyJarSignature(path); } finally { os.FS.unlink(path); }
      }
      else if (data.operation === 'graphics-smoke') {
        Transport ||= vm.loadClass('suwayomi/browser/BrowserTransport');
        pumpEnabled = true;
        result = await Host.graphicsProbe();
      }
      else if (data.operation === 'android-api-smoke') {
        Transport ||= vm.loadClass('suwayomi/browser/BrowserTransport');
        pumpEnabled = true;
        result = await Host.androidApiProbe();
      }
      else if (data.operation === 'webview-smoke') {
        Transport ||= vm.loadClass('suwayomi/browser/BrowserTransport');
        pumpEnabled = true;
        result = await Host.webViewProbe();
      }
      else if (data.operation === 'webview-loadurl-smoke') {
        Transport ||= vm.loadClass('suwayomi/browser/BrowserTransport');
        pumpEnabled = true;
        result = await Host.webViewLoadUrlProbe(data.args.url);
      }
      else if (data.operation === 'base64-smoke') result = await Host.base64Probe();
      else if (data.operation === 'webkit-cookie-smoke') result = await Host.webkitCookieProbe();
      else if (data.operation === 'reference-smoke') result = await Host.referenceProbe();
      else if (data.operation === 'zstd-smoke') result = await Host.zstdProbe();
      else if (data.operation === 'zstd-safety-smoke') result = await Host.zstdSafetyProbe();
      else if (data.operation === 'filesystem-smoke') result = await Host.filesystemProbe(data.args.action);
      else if (data.operation === 'io-smoke') result = await Host.binaryReadProbe();
      else if (data.operation === 'source-controls-smoke') {
        traceNative = data.args.trace === true;
        try { result = await Host.sourceControlsProbe(); } finally { traceNative = false; }
      }
      else if (data.operation === 'request-body-smoke') {
        Transport ||= vm.loadClass('suwayomi/browser/BrowserTransport');
        pumpEnabled = true;
        result = await Host.requestBodyProbe();
      }
      else if (data.operation === 'preferences') {
        Context ||= vm.loadClass('android/content/Context');
        if (data.args.restore != null) await Context.restorePreferences(data.args.restore);
        result = await Context.exportPreferences();
      }
      else if (data.operation === 'state') {
        Context ||= vm.loadClass('android/content/Context');
        if (data.args.restore != null) {
          if (Gateway) throw new Error('Restore JVM state before loading source classes');
          if (data.args.restore.files) restoreFilesystem(os.FS, data.args.restore.files);
          await Context.restorePreferences(data.args.restore.value);
        }
        result = { preferences: await Context.exportPreferences(), files: await captureFilesystem(os.FS) };
      }
      else if (data.operation === 'manifest') {
        const path = '/extensions/manifest-' + (++jarId) + '.apk';
        os.FS.writeFile(path, data.args.bytes);
        try { result = await Host.manifest(path); } finally { os.FS.unlink(path); }
      } else if (data.operation === 'install') {
        const id = ++jarId;
        const path = '/extensions/extension-' + id + '.jar';
        if (data.args.format === 'apk') {
          const apk = '/extensions/extension-' + id + '.apk';
          os.FS.writeFile(apk, data.args.bytes);
          progress('Converting DEX to JVM bytecode locally…');
          await Host.convert(apk, path);
          os.FS.unlink(apk);
        } else os.FS.writeFile(path, data.args.bytes);
        Gateway ||= vm.loadClass('suwayomi/browser/Gateway');
        Transport ||= vm.loadClass('suwayomi/browser/BrowserTransport');
        // Constructors can perform HTTP/JS work too; service them while the
        // source factory initializes, not only after installation finishes.
        pumpEnabled = true;
        const sources = [];
        for (const className of data.args.classNames) sources.push(...JSON.parse(await Gateway.install(path, className)));
        result = { sources, jar: os.FS.readFile(path) };
        pumpEnabled = true;
        progress('Loaded ' + sources.length + ' source(s) from extension bytecode.');
      } else if (data.operation === 'call') {
        if (!Gateway) throw new Error('Install an extension first.');
        result = JSON.parse(await Gateway.call(JSON.stringify(data.args)));
      } else throw new Error('Unknown JVM command.');
      postMessage({ id: data.id, result });
    } catch (error) {
      let message = error?.message || '';
      try { if (typeof error?.getMessage === 'function') message = String(await error.getMessage()); } catch {}
      const deniedOrigins = matchingPermissionDenials(message, commandPermissionDenials);
      postMessage({ id: data.id, error: await describe(error), deniedOrigins });
    } finally { commandPermissionDenials = []; }
  });
};
