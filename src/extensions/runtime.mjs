import { sourceFetchHop } from './transport.mjs';
import { BrowserWebViewHost } from './webview.mjs';
import { permissionDenials } from './permission-denial.mjs';

export class ExtensionRuntime {
  constructor({ transport = sourceFetchHop, onProgress = () => {}, workerUrl = new URL('./worker.mjs', import.meta.url), webview = null } = {}) {
    this.worker = new Worker(workerUrl, { type: 'module' });
    this.pending = new Map();
    this.nextId = 0;
    this.onProgress = onProgress;
    this.transport = transport;
    this.webview = webview || (typeof document !== 'undefined' ? new BrowserWebViewHost({ transport }) : null);
    this.worker.onmessage = async ({ data }) => {
      if (data.type === 'progress') return this.onProgress(data.message);
      if (data.type === 'network') {
        for (const request of data.requests) {
          let response;
          try { response = await this.transport(request); }
          catch (error) { response = { error: error.message, deniedOrigins: permissionDenials(error) }; }
          this.worker.postMessage({ type: 'network-result', id: request.id, response });
        }
        return;
      }
      if (data.type === 'webview') {
        let response;
        try {
          if (!this.webview) throw new Error('Browser WebView is unavailable outside an extension document.');
          response = await this.webview.handle(data.request);
        } catch (error) { response = { error: error.message, deniedOrigins: permissionDenials(error) }; }
        this.worker.postMessage({ type: 'webview-result', id: data.request.id, response });
        return;
      }
      const pending = this.pending.get(data.id);
      if (!pending) return;
      this.pending.delete(data.id);
      clearTimeout(pending.timer);
      data.error ? pending.reject(Object.assign(new Error(data.error), { deniedOrigins: permissionDenials(data), deniedOrigin: permissionDenials(data)[0] })) : pending.resolve(data.result);
    };
    this.worker.onerror = event => this.dispose(new Error(event.message || 'Extension JVM worker failed.'));
  }
  request(operation, args = {}) {
    if (this.closed) return Promise.reject(new Error('Extension runtime is closed. Restart it before issuing a new request.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.dispose(new Error('The extension operation exceeded its time limit. Restart the extension runtime.')), 180_000);
      this.pending.set(id, { resolve, reject, timer });
      this.worker.postMessage({ type: 'command', id, operation, args });
    });
  }
  verifyJarSignature(bytes) { return this.request('verify-jar-signature', { bytes }); }
  install(bytes, classNames, format = 'jar') {
    return this.request('install', { bytes, classNames, format });
  }
  manifest(bytes) { return this.request('manifest', { bytes }); }
  call(sourceId, operation, args = {}) { return this.request('call', { sourceId, operation, ...args }); }
  smoke() { return this.request('smoke'); }
  webViewSmoke() { return this.request('webview-smoke'); }
  webViewLoadUrlProbe(url) { return this.request('webview-loadurl-smoke', { url: String(url) }); }
  dispose(error = new Error('Extension runtime closed.')) {
    this.closed = true;
    this.worker.terminate();
    this.webview?.dispose?.();
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}
