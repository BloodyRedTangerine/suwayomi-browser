import { encodeBytes, sourceFetchHop, sourceFetchStreamHop } from './transport.mjs';
import { addMissingClientHintHeaders, defaultUserAgentClientHints } from './user-agent-hints.mjs';
import { decodeWebViewResource, rewriteWebViewCss } from './webview-css.mjs';
import { corsResponseAllowed, verifySubresourceIntegrity } from './webview-integrity.mjs';
import { authorizeGeneratedInlineScripts, isCspRequestAllowed, snapshotContentSecurityPolicies, upgradeInsecureRequestUrl } from './webview-csp.mjs';
import { sandboxWebViewBootstrap } from './platform.mjs';

const MAX_PAGE_RESOURCE_BYTES = 16 * 1024 * 1024;

async function extensionNavigationBridge(message) {
  if (!globalThis.chrome?.runtime?.id) {
    if (message.action === 'begin' && Object.keys(message.headers || {}).length)
      throw new Error('Custom WebView navigation headers require the installed browser extension.');
    return { ok: true };
  }
  if (!globalThis.chrome.runtime.sendMessage) throw new Error('The browser WebView navigation broker is unavailable.');
  const response = await globalThis.chrome.runtime.sendMessage({ type: 'suwayomi:webview-navigation', ...message });
  if (!response) throw new Error('The browser WebView navigation broker did not respond.');
  if (response.error) throw new Error(response.error);
  return response;
}

/**
 * Browser-side document host for the small WebView surface used by source
 * extensions. Each session is an opaque sandboxed iframe: extension HTML can
 * run DOM/Canvas/JavaScript locally, but it cannot reach the Suwayomi page.
 * Messages cross only through the explicit bridge installed by the JVM stub.
 */
export class BrowserWebViewHost {
  constructor({ transport = sourceFetchHop, streamTransport = transport === sourceFetchHop ? sourceFetchStreamHop : transport, clientHints = defaultUserAgentClientHints(), onTrace = () => {}, navigationBridge = extensionNavigationBridge } = {}) { this.sessions = new Map(); this.transport = transport; this.streamTransport = streamTransport; this.clientHints = clientHints; this.onTrace = onTrace; this.navigationBridge = navigationBridge; }

  async handle(request) {
    const sessionId = String(request.session ?? '');
    if (!sessionId) throw new Error('Browser WebView request is missing its session.');
    if (request.action === 'create') {
      if (this.sessions.has(sessionId)) throw new Error('Browser WebView session already exists.');
      this.sessions.set(sessionId, new BrowserWebViewSession(sessionId, this.transport, this.streamTransport, this.clientHints, this.onTrace, this.navigationBridge));
      return { ok: true };
    }
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error('Browser WebView session is not available.');
    try {
      const response = await session.handle(request);
      if (request.action === 'close') this.sessions.delete(sessionId);
      return response;
    } catch (error) {
      if (request.action === 'close') this.sessions.delete(sessionId);
      throw error;
    }
  }

  dispose() {
    for (const session of this.sessions.values()) session.close();
    this.sessions.clear();
  }
}

class BrowserWebViewSession {
  constructor(id, transport, streamTransport, clientHints, onTrace, navigationBridge) {
    this.id = id;
    this.key = `suwayomi-browser-webview-${id}`;
    this.iframe = null;
    this.srcdoc = false;
    this.pendingDocument = null;
    this.events = [];
    this.waiters = [];
    this.evaluations = new Map();
    this.nextEvaluation = 0;
    this.resourceWaiters = new Map();
    this.resourceControllers = new Map();
    this.resourceStreamAcks = new Map();
    this.cancelledResourceIds = new Set();
    this.nextPageResource = 0;
    this.cspPolicies = [];
    this.documentBaseUrl = 'about:blank';
    this.transport = transport;
    this.streamTransport = streamTransport;
    this.clientHints = clientHints;
    this.onTrace = onTrace;
    this.navigationBridge = navigationBridge;
    this.navigationRuleId = null;
    this.closed = false;
    this.onMessage = event => {
      if (this.closed || !this.iframe || event.source !== this.iframe.contentWindow) return;
      const data = event.data;
      if (!data || data.key !== this.key) return;
      try { this.onTrace({ type: 'frame-message', messageType: String(data.type || '') }); } catch {}
      if (data.type === 'bridge') this.push({ type: 'bridge', name: String(data.name || ''), message: String(data.message ?? '') });
      else if (data.type === 'bootstrapReady') {
        if (data.declaredSandbox) this.onTrace({ type: 'sandbox-isolation', extensionAPIs: data.extensionAPIs === true });
        const html = this.pendingDocument;
        if (typeof html !== 'string' || !this.iframe?.contentWindow) return;
        this.pendingDocument = null;
        this.iframe.contentWindow.postMessage({ key: this.key, type: 'loadDocument', html }, '*');
      }
      else if (data.type === 'bootstrapError') this.push({ type: 'error', message: String(data.message || 'Sandbox bootstrap failed.') });
      else if (data.type === 'evaluation') {
        const resolve = this.evaluations.get(String(data.id));
        if (!resolve) return;
        this.evaluations.delete(String(data.id));
        resolve(data.error ? { error: String(data.error) } : { value: data.value ?? null });
      } else if (data.type === 'resourceRequest') {
        const request = { ...(data.request || {}) };
        if (!request.id || typeof request.url !== 'string') return;
        request.url = upgradeInsecureRequestUrl(this.cspPolicies, request.url);
        const directive = String(request.cspDirective || 'connect-src');
        if (!isCspRequestAllowed({
          policies: this.cspPolicies, baseUrl: this.documentBaseUrl, resourceUrl: request.url, directive,
        })) {
          this.traceCspFailure(request.url, directive, 'runtime');
          try {
            this.iframe.contentWindow.postMessage({
              key: this.key, type: 'resourceComplete', id: String(request.id), error: `Blocked by source Content Security Policy (${directive}): ${request.url}`,
            }, '*');
          } catch {}
          return;
        }
        this.push({
          type: 'resourceRequest', id: String(request.id), url: request.url,
          method: String(request.method || 'GET'), headers: addMissingClientHintHeaders(request.headers || [], this.clientHints), body: request.body || '',
          corsMode: request.corsMode === true,
          credentialsMode: String(request.credentialsMode || 'include'),
          requestOrigin: String(request.requestOrigin || ''),
        });
      } else if (data.type === 'resourceAbort') this.abortResource(String(data.id || ''));
      else if (data.type === 'resourceAck') this.resourceStreamAcks.get(String(data.id || ''))?.();
    };
  }

  async handle(request) {
    if (request.action === 'loadData') return this.loadData(request);
    if (request.action === 'loadUrl') return this.loadUrl(request);
    if (request.action === 'mainFrameInterceptResult') return this.completeMainFrameInterception(request);
    if (request.action === 'awaitEvent') return { event: await this.nextEvent() };
    if (request.action === 'evaluate') return this.evaluate(request.script);
    if (request.action === 'resourceResult') return this.resourceResult(request);
    if (request.action === 'resourceComplete') return this.completeResource(request);
    if (request.action === 'close') { this.close(); return { ok: true }; }
    throw new Error(`Unsupported browser WebView action: ${request.action}`);
  }

  async loadData({ baseUrl, html, mimeType = 'text/html' }) {
    if (this.iframe) throw new Error('Browser WebView can only load one document per session.');
    if (mimeType !== 'text/html' && mimeType !== 'application/xhtml+xml') throw new Error(`Browser WebView cannot load ${mimeType}.`);
    this.srcdoc = true;
    const resolvedBase = String(baseUrl || 'about:blank');
    this.documentBaseUrl = resolvedBase;
    const prepared = await this.prepareExternalScripts(resolvedBase, String(html || ''));
    const documentText = composeSrcdoc(this.key, resolvedBase, prepared.html, prepared.scripts, prepared.images, this.cspPolicies,
      { isolatedDataImages: Boolean(sandboxWebViewBootstrap(this.key)) });
    this.pendingDocument = documentText;
    this.installFrame();
    this.iframe.dataset.baseUrl = resolvedBase;
    // Keep the initial data URL small. Some Chromium paths reject large data
    // navigations; the opaque data-origin bootstrap writes the prepared
    // document into itself without adding allow-same-origin or widening CSP.
    this.iframe.src = sandboxWebViewBootstrap(this.key) || composeDocumentBootstrap(this.key);
    document.documentElement.append(this.iframe);
    return { ok: true };
  }

  async prepareExternalScripts(baseUrl, html) {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const cspSnapshot = snapshotContentSecurityPolicies(parsed);
    this.cspPolicies = cspSnapshot.policies;
    const documentEncoding = parsed.characterSet || 'utf-8';
    const scripts = [];
    const generatedInlineScripts = [];
    for (const node of [...parsed.querySelectorAll('script[src]')]) {
      const src = node.getAttribute('src');
      let url;
      try { url = new URL(src, baseUrl); } catch { throw new Error(`Invalid WebView script URL: ${src}`); }
      const nonce = node.getAttribute('nonce') || '';
      const integrityMetadata = node.getAttribute('integrity') || '';
      const cspPolicies = cspSnapshot.policiesByElement.get(node) || [];
      url = new URL(upgradeInsecureRequestUrl(cspPolicies, url.href));
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`WebView script protocol is not supported: ${url.protocol}`);
      const asyncScript = node.hasAttribute('async');
      // HTML gives async precedence when both boolean attributes are present.
      const defer = !asyncScript && node.hasAttribute('defer');
      const type = (node.getAttribute('type') || '').trim().toLowerCase();
      if (type && !['text/javascript', 'application/javascript', 'text/ecmascript', 'application/ecmascript'].includes(type))
        throw new Error(`WebView external script type is not supported: ${type}`);
      if (!this.isSourceCspAllowed(url.href, 'script-src-elem', { nonce, integrity: integrityMetadata, policies: cspPolicies })) {
        node.remove();
        this.traceCspFailure(url.href, 'script-src-elem', 'document');
        continue;
      }
      const integrityPolicy = getIntegrityPolicy(node, url, baseUrl);
      if (integrityPolicy?.requiresCors && !integrityPolicy.request.corsMode) {
        node.remove();
        this.traceIntegrityFailure(url.href, 'cross-origin SRI script is missing crossorigin');
        continue;
      }
      let sourceResponse;
      try {
        sourceResponse = await this.requestPageResource(url.href, baseUrl, { ...integrityPolicy?.request, cspDirective: 'script-src-elem', cspPolicies });
        if (sourceResponse.blockedByCsp) {
          node.remove();
          this.traceCspFailure(url.href, 'script-src-elem', 'redirect');
          continue;
        }
        if (!Number.isInteger(sourceResponse.status) || sourceResponse.status < 200 || sourceResponse.status >= 300)
          throw new Error(`WebView script request failed with HTTP ${sourceResponse.status}: ${url.href}`);
      } catch (error) {
        if (!integrityPolicy) throw error;
        node.remove();
        this.traceIntegrityFailure(url.href, String(error?.message || error));
        continue;
      }
      let bytes;
      try { bytes = Uint8Array.from(atob(sourceResponse.body || ''), character => character.charCodeAt(0)); }
      catch (error) {
        if (!integrityPolicy) throw new Error(`WebView script response is not valid Base64: ${url.href}`);
        node.remove();
        this.traceIntegrityFailure(url.href, 'script response is not valid Base64');
        continue;
      }
      if (integrityPolicy) {
        let valid;
        try { valid = await verifySubresourceIntegrity(bytes, integrityPolicy.metadata); }
        catch (error) {
          node.remove();
          this.traceIntegrityFailure(url.href, String(error?.message || error));
          continue;
        }
        if (!valid) {
          node.remove();
          this.traceIntegrityFailure(url.href, 'script bytes do not match integrity metadata');
          continue;
        }
      }
      if (integrityPolicy) {
        node.removeAttribute('integrity');
        node.removeAttribute('crossorigin');
      }
      const code = new TextDecoder().decode(bytes);
      const scriptUrl = sourceResponse.url || url.href;
      const index = scripts.push({ url: scriptUrl, code, type: node.getAttribute('type') || '', nonce, defer, async: asyncScript }) - 1;
      generatedInlineScripts.push(`${code}\n//# sourceURL=${String(scriptUrl).replace(/[\r\n]/g, '')}`);
      if (defer) {
        node.remove();
        continue;
      }
      const marker = parsed.createElement('script');
      if (nonce) marker.setAttribute('nonce', nonce);
      marker.textContent = asyncScript
        ? `window.__suwayomiRunExternalScriptAsync(${index});`
        : `window.__suwayomiRunExternalScript(${index});`;
      generatedInlineScripts.push(marker.textContent);
      node.replaceWith(marker);
    }
    const makeCssResourceLoader = cspPolicies => (url, referrer, kind) => this.requestPageResource(url, referrer, {
      cspDirective: kind === 'stylesheet' ? 'style-src-elem' : kind === 'font' ? 'font-src' : 'img-src', cspPolicies,
    });
    for (const node of [...parsed.querySelectorAll('link[href]')]) {
      if (!node.relList.contains('stylesheet') || node.hasAttribute('disabled')) continue;
      const href = node.getAttribute('href');
      let url;
      try { url = new URL(href, baseUrl); } catch { throw new Error(`Invalid WebView stylesheet URL: ${href}`); }
      const nonce = node.getAttribute('nonce') || '';
      const integrityMetadata = node.getAttribute('integrity') || '';
      const cspPolicies = cspSnapshot.policiesByElement.get(node) || [];
      url = new URL(upgradeInsecureRequestUrl(cspPolicies, url.href));
      if (url.protocol === 'data:' || url.protocol === 'blob:') continue;
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error(`WebView stylesheet protocol is not supported: ${url.protocol}`);
      if (!this.isSourceCspAllowed(url.href, 'style-src-elem', { nonce, integrity: integrityMetadata, policies: cspPolicies })) {
        this.disableStylesheet(node);
        this.traceCspFailure(url.href, 'style-src-elem', 'document');
        continue;
      }
      const integrityPolicy = getIntegrityPolicy(node, url, baseUrl);
      const integrity = integrityPolicy?.metadata ?? null;
      if (integrityPolicy?.requiresCors && !integrityPolicy.request.corsMode) {
        this.disableStylesheet(node);
        this.traceIntegrityFailure(url.href, 'cross-origin SRI stylesheet is missing crossorigin');
        continue;
      }
      let response;
      try {
        response = await this.requestPageResource(url.href, baseUrl, { ...integrityPolicy?.request, cspDirective: 'style-src-elem', cspPolicies });
        if (response.blockedByCsp) {
          this.disableStylesheet(node);
          this.traceCspFailure(url.href, 'style-src-elem', 'redirect');
          continue;
        }
        if (integrity !== null && Number.isInteger(response.status) && response.status >= 200 && response.status < 300) {
          if (!(await verifySubresourceIntegrity(decodeResourceBytes(response.body || ''), integrity))) {
            this.disableStylesheet(node);
            this.traceIntegrityFailure(url.href, 'stylesheet bytes do not match integrity metadata');
            continue;
          }
        }
      } catch (error) {
        if (integrity === null) throw error;
        this.disableStylesheet(node);
        this.traceIntegrityFailure(url.href, String(error?.message || error));
        continue;
      }
      const decoded = Number.isInteger(response.status) && response.status >= 200 && response.status < 300
        ? decodeWebViewResource(response, { environmentEncoding: documentEncoding })
        : { text: '', encoding: documentEncoding };
      const rewritten = await rewriteWebViewCss(decoded.text, response.url || url.href, makeCssResourceLoader(cspPolicies), { environmentEncoding: decoded.encoding });
      if (integrity !== null) {
        node.removeAttribute('integrity');
        node.removeAttribute('crossorigin');
      }
      node.setAttribute('href', `data:text/css;charset=utf-8;base64,${encodeBytes(new TextEncoder().encode(rewritten))}`);
    }
    for (const node of [...parsed.querySelectorAll('style')]) {
      const type = (node.getAttribute('type') || '').trim().toLowerCase();
      if (type && type !== 'text/css') continue;
      node.textContent = await rewriteWebViewCss(node.textContent || '', baseUrl, makeCssResourceLoader(cspSnapshot.policiesByElement.get(node) || []), { environmentEncoding: documentEncoding });
    }
    for (const node of [...parsed.querySelectorAll('[style]')])
      node.setAttribute('style', await rewriteWebViewCss(node.getAttribute('style') || '', baseUrl, makeCssResourceLoader(cspSnapshot.policiesByElement.get(node) || []), { environmentEncoding: documentEncoding }));
    const images = [];
    for (const node of [...parsed.querySelectorAll('img[src]')]) {
      const pictureSourceSet = node.closest('picture')?.querySelector('source[srcset]');
      if (node.hasAttribute('srcset') || pictureSourceSet) continue;
      const src = node.getAttribute('src');
      let url;
      try { url = new URL(src, baseUrl); } catch { node.removeAttribute('src'); continue; }
      if (['data:', 'blob:'].includes(url.protocol)) continue;
      const cspPolicies = cspSnapshot.policiesByElement.get(node) || [];
      url = new URL(upgradeInsecureRequestUrl(cspPolicies, url.href));
      if (!['http:', 'https:'].includes(url.protocol)) { node.removeAttribute('src'); continue; }
      if (!this.isSourceCspAllowed(url.href, 'img-src', { policies: cspPolicies })) {
        node.removeAttribute('src');
        this.traceCspFailure(url.href, 'img-src', 'document');
        continue;
      }
      const index = images.push(url.href) - 1;
      node.removeAttribute('src');
      node.setAttribute('data-suwayomi-image', String(index));
      const marker = parsed.createElement('script');
      marker.textContent = `window.__suwayomiLoadExternalImage(${index},document.querySelector('[data-suwayomi-image="${index}"]'));`;
      generatedInlineScripts.push(marker.textContent);
      node.after(marker);
    }
    await authorizeGeneratedInlineScripts(parsed, generatedInlineScripts);
    return { html: '<!doctype html>' + parsed.documentElement.outerHTML, scripts, images };
  }

  async requestPageResource(url, documentUrl, { corsMode = false, requireCors = false, credentialsMode = 'include', requestOrigin = '', cspDirective = '', cspPolicies } = {}) {
    const document = new URL(documentUrl);
    const sourceOrigin = requestOrigin || document.origin;
    const activeCspPolicies = cspPolicies ?? this.cspPolicies;
    let current = new URL(upgradeInsecureRequestUrl(activeCspPolicies, url));
    const referrer = current.origin === document.origin ? document.href : document.origin + '/';
    for (let count = 0; ; count++) {
      current = new URL(upgradeInsecureRequestUrl(activeCspPolicies, current.href));
      if (cspDirective && !this.isSourceCspAllowed(current.href, cspDirective, { policies: activeCspPolicies })) {
        this.traceCspFailure(current.href, cspDirective, count ? 'redirect' : 'document');
        return { status: 0, statusText: '', headers: [], body: '', url: current.href, blockedByCsp: true };
      }
      if (current.origin !== sourceOrigin && requireCors && !corsMode) throw new Error(`Cross-origin WebView resource requires CORS: ${current.href}`);
      const id = `page-resource-${++this.nextPageResource}`;
      const headers = [['Accept', '*/*'], ['Referer', referrer]];
      if (corsMode && current.origin !== sourceOrigin) headers.push(['Origin', sourceOrigin]);
      const request = {
        url: current.href, method: 'GET', headers: addMissingClientHintHeaders(headers, this.clientHints), body: '',
        corsMode, credentialsMode, requestOrigin: sourceOrigin,
      };
      const promise = new Promise((resolve, reject) => this.resourceWaiters.set(id, { resolve, reject }));
      this.push({ type: 'resourceRequest', id, ...request });
      const response = await promise;
      if (corsMode && current.origin !== sourceOrigin && !corsResponseAllowed(response, { documentOrigin: sourceOrigin, resourceUrl: current.href, credentialsMode }))
        throw new Error(`Cross-origin WebView resource failed its CORS check: ${current.href}`);
      if (![301, 302, 303, 307, 308].includes(response.status)) return { ...response, url: current.href };
      const location = response.headers?.find(([name]) => name.toLowerCase() === 'location')?.[1];
      if (!location) return { ...response, url: current.href };
      if (count >= 20) throw new Error('Too many redirects while loading a WebView resource.');
      let target;
      try { target = new URL(location, current); } catch { return { ...response, url: current.href }; }
      if (!['http:', 'https:'].includes(target.protocol)) throw new Error(`WebView script redirect protocol is not supported: ${target.protocol}`);
      current = target;
    }
  }

  disableStylesheet(node) {
    node.removeAttribute('integrity');
    node.removeAttribute('crossorigin');
    node.setAttribute('href', 'data:text/css;charset=utf-8;base64,');
  }

  traceIntegrityFailure(url, reason) {
    try { this.onTrace({ type: 'stylesheet-integrity-failure', url, reason }); } catch {}
  }

  isSourceCspAllowed(resourceUrl, directive, options = {}) {
    const policies = options.policies ?? this.cspPolicies;
    return isCspRequestAllowed({
      ...options,
      policies,
      baseUrl: this.documentBaseUrl,
      resourceUrl: upgradeInsecureRequestUrl(policies, resourceUrl),
      directive,
    });
  }

  traceCspFailure(url, directive, phase) {
    try { this.onTrace({ type: 'csp-blocked-resource', url, directive, phase }); } catch {}
  }

  async loadUrl({ url, headers = {} }) {
    if (this.iframe) throw new Error('Browser WebView can only load one document per session.');
    let target;
    try { target = new URL(String(url)); }
    catch { throw new Error('WebView navigation URL is invalid.'); }
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
      throw new Error('WebView navigation supports only credential-free HTTP(S) URLs.');
    try {
      const prepared = await this.navigationBridge({ action: 'begin', url: target.href, headers });
      this.navigationRuleId = prepared?.ruleId ?? null;
      const intercepted = await this.requestMainFrameInterception(target.href, headers);
      if (intercepted) {
        this.releaseNavigationRule();
        await this.loadInterceptedMainFrame(target.href, intercepted);
        return { ok: true, intercepted: true };
      }
    } catch (error) {
      this.releaseNavigationRule();
      this.push({ type: 'error', url: target.href, message: error?.message || String(error) });
      return { ok: true };
    }
    try { this.installFrame(); }
    catch (error) { this.releaseNavigationRule(); throw error; }
    // A remote page can render inside the sandbox only when the site permits
    // framing. It deliberately has no injected bridge or same-origin access.
    try {
      this.iframe.src = target.href;
      document.documentElement.append(this.iframe);
    }
    catch (error) { this.releaseNavigationRule(); this.iframe.remove(); this.iframe = null; throw error; }
    return { ok: true, limitation: 'Unhandled remote documents keep native browser origin, redirects and CSP. Custom headers apply only to the exact initial frame navigation.' };
  }

  async requestMainFrameInterception(url, headers) {
    const id = `main-frame-${++this.nextPageResource}`;
    const response = new Promise((resolve, reject) => this.resourceWaiters.set(id, { resolve, reject }));
    this.push({
      type: 'mainFrameRequest', id, url, method: 'GET',
      headers: Object.entries(headers || {}).map(([name, value]) => [String(name), String(value)]),
    });
    return response;
  }

  completeMainFrameInterception({ resourceId, response, error }) {
    if (!resourceId) throw new Error('Browser WebView main-frame request is missing its identifier.');
    const waiter = this.resourceWaiters.get(String(resourceId));
    if (!waiter) throw new Error('Browser WebView main-frame request is no longer active.');
    this.resourceWaiters.delete(String(resourceId));
    if (error) waiter.reject(new Error(String(error)));
    else waiter.resolve(response || null);
    return { ok: true };
  }

  async loadInterceptedMainFrame(url, response) {
    if (this.iframe) throw new Error('Browser WebView can only load one document per session.');
    const contentType = response.headers?.find(([name]) => String(name).toLowerCase() === 'content-type')?.[1] || 'text/html';
    const mimeType = String(contentType).split(';', 1)[0].trim().toLowerCase();
    if (mimeType !== 'text/html' && mimeType !== 'application/xhtml+xml')
      throw new Error(`An intercepted main-frame response of type ${mimeType} cannot yet be rendered by the browser WebView.`);
    const decoded = decodeWebViewResource(response);
    const html = injectResponseSecurityPolicies(decoded.text, response.headers || []);
    this.srcdoc = true;
    this.documentBaseUrl = url;
    const prepared = await this.prepareExternalScripts(url, html);
    this.pendingDocument = composeSrcdoc(this.key, url, prepared.html, prepared.scripts, prepared.images, this.cspPolicies,
      { isolatedDataImages: Boolean(sandboxWebViewBootstrap(this.key)) });
    this.installFrame();
    this.iframe.dataset.baseUrl = url;
    this.iframe.src = sandboxWebViewBootstrap(this.key) || composeDocumentBootstrap(this.key);
    document.documentElement.append(this.iframe);
  }

  evaluate(script) {
    if (!this.srcdoc || !this.iframe?.contentWindow) throw new Error('Browser WebView evaluation is available only for sandboxed local HTML.');
    const id = String(++this.nextEvaluation);
    const promise = new Promise(resolve => this.evaluations.set(id, resolve));
    this.iframe.contentWindow.postMessage({ key: this.key, type: 'evaluate', id, script: String(script) }, '*');
    return promise.then(response => {
      if (response.error) throw new Error(response.error);
      return response;
    });
  }

  async resourceResult({ resourceId, request, response }) {
    if (!resourceId || !request) throw new Error('Browser WebView resource response is missing its request.');
    // Source-created WebResourceResponses still cross Java, but an ordinary
    // network body can be much larger than the host callback metadata. Keep
    // that body in the browser, deliver it directly to the pending page
    // resource, and return only response headers so Java can import cookies
    // before its event loop handles a subsequent redirect/fetch.
    if (response != null) return { response, intercepted: true };
    const key = String(resourceId);
    const controller = new AbortController();
    if (this.cancelledResourceIds.delete(key)) controller.abort(new DOMException('The WebView request was aborted.', 'AbortError'));
    this.resourceControllers.set(key, controller);
    let streaming = false;
    try {
      const networkResponse = await this.streamTransport(request, { signal: controller.signal });
      if (!networkResponse || !Number.isInteger(networkResponse.status)) throw new Error('Browser WebView received an invalid HTTP response.');
      if (networkResponse.body && typeof networkResponse.body.getReader === 'function') {
        if (this.resourceWaiters.has(key)) {
          const body = await this.readPageResourceBody(networkResponse.body, controller);
          this.completeResource({
            resourceId,
            response: { ...networkResponse, body: encodeBytes(body), url: request.url, requestMethod: request.method },
          });
          return { deferred: true, responseMeta: { headers: networkResponse.headers || [] } };
        }
        this.streamResource(resourceId, request, networkResponse, controller);
        streaming = true;
        return { deferred: true, responseMeta: { headers: networkResponse.headers || [] } };
      }
      this.completeResource({
        resourceId,
        response: { ...networkResponse, url: request.url, requestMethod: request.method },
      });
      return { deferred: true, responseMeta: { headers: networkResponse.headers || [] } };
    } catch (error) {
      const message = String(error?.message || error);
      this.completeResource({ resourceId, error: message });
      return { deferred: true, error: message };
    } finally {
      if (!streaming) {
        if (this.resourceControllers.get(key) === controller) this.resourceControllers.delete(key);
        this.cancelledResourceIds.delete(key);
      }
    }
  }

  streamResource(resourceId, request, response, controller) {
    const id = String(resourceId), target = this.iframe?.contentWindow;
    if (!target) throw new Error('Browser WebView stream has no active sandbox document.');
    const { body, ...metadata } = response;
    target.postMessage({ key: this.key, type: 'resourceHeaders', id, response: { ...metadata, requestMethod: request.method } }, '*');
    const reader = body.getReader();
    void (async () => {
      try {
        while (true) {
          if (controller.signal.aborted) throw controller.signal.reason;
          const part = await reader.read();
          if (part.done) break;
          const bytes = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
          for (let offset = 0; offset < bytes.length; offset += 48 * 1024) {
            if (controller.signal.aborted) throw controller.signal.reason;
            const acknowledged = this.waitForResourceAck(id, controller.signal);
            try { target.postMessage({ key: this.key, type: 'resourceChunk', id, body: encodeBytes(bytes.subarray(offset, offset + 48 * 1024)) }, '*'); }
            catch (error) { controller.abort(error); }
            await acknowledged;
          }
        }
        target.postMessage({ key: this.key, type: 'resourceEnd', id }, '*');
      } catch (error) {
        try { target.postMessage({ key: this.key, type: 'resourceError', id, error: String(error?.message || error) }, '*'); } catch {}
      } finally {
        if (this.resourceControllers.get(id) === controller) this.resourceControllers.delete(id);
        this.cancelledResourceIds.delete(id);
      }
    })();
  }

  async readPageResourceBody(body, controller) {
    const reader = body.getReader();
    const chunks = [];
    let size = 0;
    try {
      while (true) {
        if (controller.signal.aborted) throw controller.signal.reason;
        const part = await reader.read();
        if (part.done) break;
        const chunk = part.value instanceof Uint8Array ? part.value : new Uint8Array(part.value);
        size += chunk.byteLength;
        if (size > MAX_PAGE_RESOURCE_BYTES) {
          const error = new Error(`WebView page resource exceeds the ${MAX_PAGE_RESOURCE_BYTES}-byte processing limit.`);
          controller.abort(error);
          try { await reader.cancel(error); } catch {}
          throw error;
        }
        chunks.push(chunk);
      }
    } catch (error) {
      if (!controller.signal.aborted) controller.abort(error);
      throw error;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    return bytes;
  }

  waitForResourceAck(id, signal) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        signal.removeEventListener('abort', onAbort);
        if (this.resourceStreamAcks.get(id) === acknowledge) this.resourceStreamAcks.delete(id);
      };
      const finish = callback => {
        if (settled) return;
        settled = true; cleanup(); callback();
      };
      const acknowledge = () => finish(resolve);
      const onAbort = () => finish(() => reject(signal.reason || new DOMException('The WebView response stream was aborted.', 'AbortError')));
      this.resourceStreamAcks.set(id, acknowledge);
      if (signal.aborted) onAbort(); else signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  abortResource(resourceId) {
    if (!resourceId) return;
    const controller = this.resourceControllers.get(resourceId);
    if (controller) controller.abort(new DOMException('The WebView request was aborted.', 'AbortError'));
    else this.cancelledResourceIds.add(resourceId);
  }

  completeResource({ resourceId, response, error }) {
    if (!resourceId) throw new Error('Browser WebView resource request is missing its identifier.');
    const waiter = this.resourceWaiters.get(String(resourceId));
    if (waiter) {
      this.resourceWaiters.delete(String(resourceId));
      if (error) waiter.reject(new Error(String(error)));
      else if (response) waiter.resolve(response);
      else waiter.reject(new Error('Browser WebView resource response is empty.'));
      return { ok: true };
    }
    if (!this.iframe?.contentWindow) throw new Error('Browser WebView resource request is no longer active.');
    this.iframe.contentWindow.postMessage({
      key: this.key, type: 'resourceComplete', id: String(resourceId),
      response: response || null, error: error ? String(error) : '',
    }, '*');
    return { ok: true };
  }

  installFrame() {
    if (typeof document === 'undefined') throw new Error('Browser WebView requires an extension document.');
    this.iframe = document.createElement('iframe');
    this.iframe.setAttribute('sandbox', 'allow-scripts allow-forms allow-modals');
    this.iframe.setAttribute('aria-hidden', 'true');
    this.iframe.style.cssText = 'position:fixed;left:-10000px;top:-10000px;width:1px;height:1px;border:0;opacity:0;pointer-events:none;';
    this.iframe.addEventListener('load', () => {
      this.releaseNavigationRule();
      this.push({ type: 'pageFinished', url: this.iframe?.dataset.baseUrl || this.iframe?.src || '' });
    });
    this.iframe.addEventListener('error', () => {
      this.releaseNavigationRule();
      this.push({ type: 'error', message: 'Browser WebView document failed to load.' });
    });
    window.addEventListener('message', this.onMessage);
    this.onPageHide = () => this.releaseNavigationRule();
    window.addEventListener('pagehide', this.onPageHide, { once: true });
  }

  releaseNavigationRule() {
    const ruleId = this.navigationRuleId;
    if (ruleId == null || this.navigationCleanup) return;
    this.navigationCleanup = Promise.resolve(this.navigationBridge({ action: 'end', ruleId })).then(() => {
      if (this.navigationRuleId === ruleId) this.navigationRuleId = null;
    }).catch(error => {
      try { this.onTrace({ type: 'webview-navigation-rule-cleanup-failed', message: error?.message || String(error) }); } catch {}
    }).finally(() => { this.navigationCleanup = null; });
    this.navigationCleanup.catch(() => {});
  }

  nextEvent() {
    if (this.events.length) return Promise.resolve(this.events.shift());
    if (this.closed) return Promise.resolve({ type: 'closed' });
    return new Promise(resolve => this.waiters.push(resolve));
  }

  push(event) {
    try { this.onTrace(event); } catch {}
    const waiter = this.waiters.shift();
    if (waiter) waiter(event); else this.events.push(event);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.evaluations.values()) resolve({ error: 'Browser WebView was closed.' });
    this.evaluations.clear();
    for (const controller of this.resourceControllers.values()) controller.abort(new DOMException('Browser WebView was closed.', 'AbortError'));
    this.resourceControllers.clear(); this.resourceStreamAcks.clear(); this.cancelledResourceIds.clear();
    for (const waiter of this.resourceWaiters.values()) waiter.reject(new Error('Browser WebView was closed.'));
    this.resourceWaiters.clear();
    this.pendingDocument = null;
    this.push({ type: 'closed' });
    window.removeEventListener('message', this.onMessage);
    window.removeEventListener('pagehide', this.onPageHide);
    this.releaseNavigationRule();
    this.iframe?.remove();
    this.iframe = null;
  }
}

export function injectResponseSecurityPolicies(html, headers) {
  const policies = (headers || [])
    .filter(pair => Array.isArray(pair) && String(pair[0]).toLowerCase() === 'content-security-policy')
    .map(pair => String(pair[1] || ''))
    .filter(Boolean);
  if (!policies.length) return String(html || '');
  const metas = policies.map(policy => `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(policy).replace(/'/g, '&#39;')}">`).join('');
  const head = /<head\b[^>]*>/i;
  if (head.test(html)) return String(html).replace(head, opening => opening + metas);
  const document = /<html\b[^>]*>/i;
  if (document.test(html)) return String(html).replace(document, opening => `${opening}<head>${metas}</head>`);
  return `<!doctype html><head>${metas}</head>${String(html || '')}`;
}

function composeDocumentBootstrap(key) {
  const policy = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline' blob: data:; img-src blob: data:; font-src blob: data:; worker-src blob:; media-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'";
  const script = `(function(){const key=${JSON.stringify(key)};window.addEventListener('message',function(event){const data=event.data;if(event.source!==parent||!data||data.key!==key||data.type!=='loadDocument'||typeof data.html!=='string')return;try{document.open();document.write(data.html);document.close();parent.postMessage({key,type:'documentWritten'},'*')}catch(error){parent.postMessage({key,type:'bootstrapError',message:String(error&&error.message||error)},'*')}});parent.postMessage({key,type:'bootstrapReady'},'*')})()`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(`<!doctype html><meta http-equiv="Content-Security-Policy" content="${policy}"><script>${script}<\/script>`)}`;
}

export function composeSrcdoc(key, baseUrl, html, externalScripts = [], externalImages = [], sourceCspPolicies = [], { isolatedDataImages = false } = {}) {
  const base = escapeAttribute(baseUrl);
  let documentOrigin = 'null';
  try { documentOrigin = new URL(baseUrl).origin; } catch {}
  const scripts = JSON.stringify(externalScripts).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const images = JSON.stringify(externalImages).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const policies = JSON.stringify(sourceCspPolicies).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
  const policy = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' blob:; style-src 'unsafe-inline' blob: data:; img-src blob: data:; font-src blob: data:; worker-src blob:; media-src blob: data:; connect-src 'none'; frame-src 'none'; object-src 'none'; form-action 'none'">`;
  const prelude = `<script>(function(){
const isolatedDataImages=${isolatedDataImages === true};
const key=${JSON.stringify(key)}, documentOrigin=${JSON.stringify(documentOrigin)}, pending=new Map(), externalScripts=${scripts}, externalImages=${images}, sourceCspPolicies=${policies}, upgradeInsecureRequests=sourceCspPolicies.some(function(policy){return String(policy).split(';').some(function(directive){return directive.trim().toLowerCase()==='upgrade-insecure-requests'})});let next=0;
function upgradeInsecureUrl(value){const url=new URL(value,document.baseURI);if(upgradeInsecureRequests&&url.protocol==='http:'){url.protocol='https:';if(url.port==='80')url.port='443'}return url}
const deferredScriptIndexes=externalScripts.map(function(item,index){return item.defer?index:-1}).filter(function(index){return index>=0});let deferredScriptsStarted=false;
function runDeferredScripts(){if(deferredScriptsStarted||document.readyState!=='interactive')return;deferredScriptsStarted=true;document.removeEventListener('readystatechange',runDeferredScripts);for(const index of deferredScriptIndexes)window.__suwayomiRunExternalScript(index)}
if(deferredScriptIndexes.length)document.addEventListener('readystatechange',runDeferredScripts);
function send(v){parent.postMessage(Object.assign({key},v),'*')}
function toBase64(bytes){let value='';for(let i=0;i<bytes.length;i+=16384)value+=String.fromCharCode.apply(null,bytes.subarray(i,i+16384));return btoa(value)}
function fromBase64(value){const raw=atob(value||''),out=new Uint8Array(raw.length);for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);return out}
function request(spec,signal,cspDirective){const id=String(++next);return new Promise(function(resolve,reject){const entry={resolve,reject,signal,stream:null,pendingChunk:null,waitingRead:false,settled:false};entry.cleanup=function(){signal?.removeEventListener('abort',entry.abort)};entry.abort=function(){if(!pending.has(id))return;pending.delete(id);send({type:'resourceAbort',id});const error=signal?.reason instanceof Error?signal.reason:new DOMException('The WebView request was aborted','AbortError');try{entry.stream?.error(error)}catch{}if(!entry.settled){entry.settled=true;reject(error)}entry.cleanup()};pending.set(id,entry);if(signal?.aborted){entry.abort();return}signal?.addEventListener('abort',entry.abort,{once:true});send({type:'resourceRequest',request:{id,url:spec.url,method:spec.method,headers:spec.headers,body:spec.body,cspDirective}})})}
function toResponse(data,stream){if(!data||data.status===0)throw new Error('Browser WebView received an invalid HTTP response');const headers=new Headers(data.headers||[]);headers.delete('set-cookie');const status=Number(data.status),noBody=String(data.requestMethod||'').toUpperCase()==='HEAD'||[204,205,304].includes(status),body=noBody?null:stream!==undefined?stream:fromBase64(data.body),result=new Response(body,{status,statusText:data.statusText||'',headers});try{Object.defineProperty(result,'url',{value:data.url||''})}catch{}return result}
function follow(spec,count,mode,signal,cspDirective){return request(spec,signal,cspDirective).then(function(result){const streamed=!!(result&&result.__suwayomiStream),raw=streamed?result.response:result,stream=streamed?result.stream:undefined,status=Number(raw.status),redirect=[301,302,303,307,308].includes(status),asResponse=function(){return toResponse(raw,stream)},cancelStream=function(){try{const cancelled=stream?.cancel();cancelled?.catch(()=>{})}catch{}};if(!redirect||mode==='manual')return asResponse();if(mode==='error'){cancelStream();throw new TypeError('Redirect encountered while redirect mode is error')}const location=(raw.headers||[]).find(function(h){return String(h[0]).toLowerCase()==='location'});if(!location)return asResponse();if(count>=20){cancelStream();throw new TypeError('Too many redirects')}const target=new URL(location[1],spec.url);if(!['http:','https:'].includes(target.protocol)){cancelStream();throw new TypeError('Unsupported redirect protocol')}const headers=new Headers(spec.headers);let method=spec.method,body=spec.body;if((status===303&&!['GET','HEAD'].includes(method))||([301,302].includes(status)&&method==='POST')){method='GET';body='';for(const name of ['content-type','content-length','content-encoding'])headers.delete(name)}if(new URL(spec.url).origin!==target.origin)for(const name of ['authorization','proxy-authorization','cookie','origin'])headers.delete(name);cancelStream();return follow({url:target.href,method,headers:Array.from(headers.entries()),body},count+1,mode,signal,cspDirective)})}
function brokerFetch(input,init,cspDirective){let req;try{req=new Request(input,init)}catch(error){return Promise.reject(error)}if(!['http:','https:'].includes(new URL(req.url).protocol))return Promise.reject(new TypeError('Browser WebView fetch supports HTTP(S) only'));const mode=(init&&init.redirect)||req.redirect||'follow',url=upgradeInsecureUrl(req.url).href;return req.clone().arrayBuffer().then(function(body){const method=req.method;return follow({url,method,headers:Array.from(req.headers.entries()),body:['GET','HEAD'].includes(method)?'':toBase64(new Uint8Array(body))},0,mode,req.signal,cspDirective)})}
window.fetch=function(input,init){return brokerFetch(input,init,'connect-src')};
const XHR_OPENED=1, XHR_HEADERS=2, XHR_LOADING=3, XHR_DONE=4;
class BrokerXHR extends EventTarget{
constructor(){super();this.readyState=0;this.status=0;this.statusText='';this.responseURL='';this.responseType='';this.timeout=0;this.withCredentials=false;this.upload=new EventTarget();this.onreadystatechange=null;this.onloadstart=null;this.onprogress=null;this.onload=null;this.onerror=null;this.ontimeout=null;this.onabort=null;this.onloadend=null;this.__wv=this.__newRequestState()}
__newRequestState(){return{headers:new Headers(),responseHeaders:new Headers(),response:null,text:'',aborted:false,terminal:false,timer:0,controller:null}}
get responseText(){if(this.responseType&&this.responseType!=='text')throw new DOMException('responseText is unavailable for this responseType','InvalidStateError');return this.__wv.text}
get response(){return this.__wv.response}
get responseXML(){return this.responseType==='document'?this.__wv.response:null}
open(method,url,async){if(async===false)throw new DOMException('Synchronous WebView XHR is not supported','NotSupportedError');if(this.readyState!==0&&this.readyState!==XHR_DONE)this.abort();this.__wv=this.__newRequestState();this.__wv.method=String(method||'GET').toUpperCase();this.__wv.url=new URL(String(url),document.baseURI).href;this.readyState=XHR_OPENED;this.status=0;this.statusText='';this.responseURL='';this.__fire('readystatechange')}
setRequestHeader(name,value){if(this.readyState!==XHR_OPENED)throw new DOMException('XHR is not open','InvalidStateError');this.__wv.headers.append(String(name),String(value))}
overrideMimeType(value){if(this.readyState===XHR_LOADING||this.readyState===XHR_DONE)throw new DOMException('The response has already started loading','InvalidStateError');this.__wv.mimeType=String(value)}
getResponseHeader(name){return this.readyState<XHR_HEADERS?null:this.__wv.responseHeaders.get(String(name))}
getAllResponseHeaders(){if(this.readyState<XHR_HEADERS)return '';return Array.from(this.__wv.responseHeaders.entries()).map(function(pair){return pair[0]+': '+pair[1]+'\\r\\n'}).join('')}
send(body){
if(this.readyState!==XHR_OPENED)throw new DOMException('XHR is not open','InvalidStateError');
const state=this.__wv;if(state.sent)throw new DOMException('XHR has already been sent','InvalidStateError');
state.sent=true;state.controller=new AbortController();this.__fire('loadstart');
const method=state.method,hasBody=!['GET','HEAD'].includes(method),init={method,headers:state.headers,redirect:'follow',credentials:'omit',signal:state.controller.signal};if(hasBody&&body!=null)init.body=body;
const isCurrent=()=>this.__wv===state&&!state.aborted&&!state.terminal;
const fail=kind=>{if(!isCurrent())return;state.terminal=true;clearTimeout(state.timer);if(kind==='timeout')state.controller.abort(new DOMException('The XHR request timed out','TimeoutError'));this.status=0;this.statusText='';this.readyState=XHR_DONE;this.__fire('readystatechange');this.__fire(kind==='timeout'?'timeout':'error');this.__fire('loadend')};
if(this.timeout>0)state.timer=setTimeout(()=>fail('timeout'),this.timeout);
if(!isCurrent())return;
window.fetch(state.url,init).then(async response=>{
if(!isCurrent())return;
this.status=response.status;this.statusText=response.statusText;this.responseURL=response.url||state.url;state.responseHeaders=response.headers;this.readyState=XHR_HEADERS;this.__fire('readystatechange');
const type=this.responseType||'',declaredType=state.mimeType||response.headers.get('content-type')||'',charsetMatch=declaredType.match(/;\\s*charset\\s*=\\s*["']?([^;"'\\s]+)/i),charset=charsetMatch?charsetMatch[1]:'utf-8',decoder=(type===''||type==='text')?new TextDecoder(charset):null,chunks=[];
let loaded=0,text='',loading=false;const reader=response.body?.getReader();
if(reader)while(true){const part=await reader.read();if(part.done)break;if(!isCurrent()){try{await reader.cancel()}catch{}return}const bytes=part.value instanceof Uint8Array?part.value:new Uint8Array(part.value);if(!bytes.length)continue;chunks.push(bytes);loaded+=bytes.byteLength;if(decoder){text+=decoder.decode(bytes,{stream:true});state.text=text;if(type==='')state.response=text}if(!loading){this.readyState=XHR_LOADING;this.__fire('readystatechange');loading=true}this.__fireProgress(loaded,response.headers.get('content-length'))}
if(!isCurrent())return;if(decoder){text+=decoder.decode();state.text=text}
if(!loading){this.readyState=XHR_LOADING;this.__fire('readystatechange')}
const bytes=new Uint8Array(loaded);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength}
const decoded=decoder?text:new TextDecoder(charset).decode(bytes);
if(type===''||type==='text'){state.text=decoded;state.response=decoded}else if(type==='json'){state.text=decoded;try{state.response=decoded?JSON.parse(decoded):null}catch{state.response=null}}else if(type==='arraybuffer'){state.response=bytes.buffer}else if(type==='blob'){state.response=new Blob([bytes],{type:state.mimeType||response.headers.get('content-type')||''})}else if(type==='document'){state.text=decoded;state.response=new DOMParser().parseFromString(decoded,state.mimeType||response.headers.get('content-type')||'text/html')}else{throw new DOMException('Unsupported WebView XHR responseType: '+type,'NotSupportedError')}
if(!isCurrent())return;clearTimeout(state.timer);this.readyState=XHR_DONE;state.terminal=true;this.__fire('readystatechange');this.__fire('load');this.__fire('loadend')
}).catch(error=>{if(error&&error.name==='TimeoutError')fail('timeout');else fail('error')})
}
abort(){if(this.readyState===0||this.readyState===XHR_DONE)return;const state=this.__wv;state.aborted=true;state.terminal=true;clearTimeout(state.timer);state.controller?.abort(new DOMException('The XHR request was aborted','AbortError'));this.status=0;this.statusText='';this.responseURL='';state.response=null;state.text='';this.readyState=0;this.__fire('readystatechange');this.__fire('abort');this.__fire('loadend')}
__fireProgress(loaded,totalText){const total=Number(totalText),lengthComputable=totalText!==null&&totalText!==''&&Number.isFinite(total)&&total>=0,event=new ProgressEvent('progress',{lengthComputable,loaded,total:lengthComputable?total:0});this.dispatchEvent(event);if(typeof this.onprogress==='function')this.onprogress.call(this,event)}
__fire(type){const event=new Event(type);this.dispatchEvent(event);const handler=this['on'+type];if(typeof handler==='function')handler.call(this,event)}
}
BrokerXHR.UNSENT=0;BrokerXHR.OPENED=1;BrokerXHR.HEADERS_RECEIVED=2;BrokerXHR.LOADING=3;BrokerXHR.DONE=4;window.XMLHttpRequest=BrokerXHR;
window.__suwayomiRunExternalScript=function(index){const item=externalScripts[index];if(!item)throw new Error('Unknown brokered WebView script '+index);const script=document.createElement('script');script.type=item.type||'text/javascript';if(item.nonce)script.setAttribute('nonce',item.nonce);script.textContent=item.code+'\\n//# sourceURL='+item.url.replace(/[\\r\\n]/g,'');Object.defineProperty(script,'src',{configurable:true,get:function(){return item.url}});const getAttribute=script.getAttribute.bind(script);script.getAttribute=function(name){return String(name).toLowerCase()==='src'?item.url:getAttribute(name)};(document.head||document.documentElement).appendChild(script);script.remove()};
window.__suwayomiAsyncScriptPromises=[];
window.__suwayomiRunExternalScriptAsync=function(index){if(!externalScripts[index])throw new Error('Unknown brokered WebView script '+index);const completion=new Promise(function(resolve,reject){setTimeout(function(){try{window.__suwayomiRunExternalScript(index);resolve(true)}catch(error){reject(error)}},0)});window.__suwayomiAsyncScriptPromises.push(completion);return completion};
const imageSource=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'src'),currentImageSource=Object.getOwnPropertyDescriptor(HTMLImageElement.prototype,'currentSrc'),imageUrls=new WeakMap(),imageBlobs=new WeakMap(),imageRequests=new WeakMap(),imageTaint=new WeakMap(),taintedCanvases=new WeakSet(),taintedBitmaps=new WeakSet();
function canvasSecurityError(){return new DOMException('The canvas has been tainted by cross-origin image data','SecurityError')}
function sourceIsTainted(source){if(source instanceof HTMLImageElement)return imageTaint.get(source)===true;if(source instanceof HTMLCanvasElement||typeof OffscreenCanvas!=='undefined'&&source instanceof OffscreenCanvas)return taintedCanvases.has(source);return typeof ImageBitmap!=='undefined'&&source instanceof ImageBitmap&&taintedBitmaps.has(source)}
function originOf(value,fallback){try{return new URL(value).origin}catch{return fallback}}
function corsAllowed(response,mode){const allowed=response.headers.get('access-control-allow-origin'),credentials=response.headers.get('access-control-allow-credentials')?.toLowerCase()==='true';if(mode==='use-credentials')return allowed===documentOrigin&&credentials;return allowed==='*'||allowed===documentOrigin}
function setImageSource(image,value){const text=String(value??''),requestId=(imageRequests.get(image)||0)+1;imageRequests.set(image,requestId);imageTaint.delete(image);if(!text){imageUrls.delete(image);imageSource.set.call(image,text);return}let url;try{url=upgradeInsecureUrl(new URL(text,document.baseURI).href)}catch{image.dispatchEvent(new Event('error'));return}if(url.protocol==='data:'||url.protocol==='blob:'){imageUrls.set(image,url.href);imageTaint.set(image,false);imageSource.set.call(image,url.href);return}if(!['http:','https:'].includes(url.protocol)){image.dispatchEvent(new Event('error'));return}imageUrls.set(image,url.href);const corsMode=image.hasAttribute('crossorigin')?(image.crossOrigin||'anonymous'):'';brokerFetch(url.href,{method:'GET'},'img-src').then(function(response){if(!response.ok)throw new Error('Image request failed with HTTP '+response.status);const finalOrigin=originOf(response.url,url.origin),crossOrigin=url.origin!==documentOrigin||finalOrigin!==documentOrigin;if(corsMode&&crossOrigin&&!corsAllowed(response,corsMode))throw new Error('Cross-origin image failed its CORS check');return response.blob().then(blob=>({blob,tainted:crossOrigin&&!corsMode}))}).then(function(result){if(imageRequests.get(image)!==requestId)return;if(isolatedDataImages){const reader=new FileReader();reader.onload=function(){if(imageRequests.get(image)!==requestId)return;const previous=imageBlobs.get(image);if(previous&&previous.startsWith('blob:'))URL.revokeObjectURL(previous);const dataUrl=String(reader.result);imageBlobs.set(image,dataUrl);imageTaint.set(image,result.tainted);imageSource.set.call(image,dataUrl)};reader.onerror=function(){imageTaint.delete(image);if(imageRequests.get(image)===requestId)image.dispatchEvent(new Event('error'))};reader.readAsDataURL(result.blob);return}const previous=imageBlobs.get(image);if(previous)URL.revokeObjectURL(previous);const objectUrl=URL.createObjectURL(result.blob);imageBlobs.set(image,objectUrl);imageTaint.set(image,result.tainted);imageSource.set.call(image,objectUrl)}).catch(function(){imageTaint.delete(image);if(imageRequests.get(image)===requestId)image.dispatchEvent(new Event('error'))})}
Object.defineProperty(HTMLImageElement.prototype,'src',{configurable:true,enumerable:imageSource.enumerable,get:function(){return imageUrls.get(this)||imageSource.get.call(this)},set:function(value){setImageSource(this,value)}});
if(currentImageSource?.configurable)Object.defineProperty(HTMLImageElement.prototype,'currentSrc',{configurable:true,get:function(){return imageUrls.get(this)||currentImageSource.get.call(this)}});
const nativeSetAttribute=Element.prototype.setAttribute,nativeGetAttribute=Element.prototype.getAttribute,nativeHasAttribute=Element.prototype.hasAttribute,nativeRemoveAttribute=Element.prototype.removeAttribute;
function sourceSetImage(element){return element instanceof HTMLImageElement?element:element instanceof HTMLSourceElement?element.parentElement?.closest('picture')?.querySelector('img'):null}
function resetSourceSet(element){const image=sourceSetImage(element);if(image){imageUrls.delete(image);imageRequests.set(image,(imageRequests.get(image)||0)+1)}}
Element.prototype.setAttribute=function(name,value){const attr=String(name).toLowerCase();if(this instanceof HTMLImageElement&&attr==='src'){this.src=value;return}if((this instanceof HTMLImageElement||this instanceof HTMLSourceElement)&&attr==='srcset')resetSourceSet(this);return nativeSetAttribute.call(this,name,value)};
Element.prototype.getAttribute=function(name){if(this instanceof HTMLImageElement&&String(name).toLowerCase()==='src'&&imageUrls.has(this))return imageUrls.get(this);return nativeGetAttribute.call(this,name)};
Element.prototype.hasAttribute=function(name){if(this instanceof HTMLImageElement&&String(name).toLowerCase()==='src'&&imageUrls.has(this))return true;return nativeHasAttribute.call(this,name)};
Element.prototype.removeAttribute=function(name){const attr=String(name).toLowerCase();if((this instanceof HTMLImageElement||this instanceof HTMLSourceElement)&&attr==='srcset')resetSourceSet(this);if(this instanceof HTMLImageElement&&attr==='src'){imageUrls.delete(this);imageRequests.set(this,(imageRequests.get(this)||0)+1);const previous=imageBlobs.get(this);if(previous)URL.revokeObjectURL(previous);imageBlobs.delete(this)}return nativeRemoveAttribute.call(this,name)};
for(const prototype of [HTMLImageElement.prototype,HTMLSourceElement.prototype]){const descriptor=Object.getOwnPropertyDescriptor(prototype,'srcset');if(descriptor?.configurable)Object.defineProperty(prototype,'srcset',{configurable:true,enumerable:descriptor.enumerable,get:descriptor.get,set:function(value){resetSourceSet(this);descriptor.set.call(this,value)}})}
function blockedSourceSet(event){const image=event.target;if(!(image instanceof HTMLImageElement)||imageUrls.has(image))return;let url;try{url=new URL(currentImageSource?.get.call(image)||image.currentSrc,document.baseURI)}catch{return}if(!['http:','https:'].includes(url.protocol))return;event.stopImmediatePropagation();const picture=image.closest('picture');if(picture)for(const source of picture.querySelectorAll('source[srcset]'))nativeRemoveAttribute.call(source,'srcset');nativeRemoveAttribute.call(image,'srcset');const fallback=imageSource.get.call(image);if(/^https?:/i.test(fallback||''))nativeRemoveAttribute.call(image,'src');setImageSource(image,url.href)}
document.addEventListener('error',blockedSourceSet,true);
window.__suwayomiLoadExternalImage=function(index,image){const url=externalImages[index];if(!url||!image)throw new Error('Unknown brokered WebView image '+index);setImageSource(image,url)};
function patchCanvasContext(prototype){if(!prototype)return;if(typeof prototype.drawImage==='function'){const drawImage=prototype.drawImage;prototype.drawImage=function(source,...args){const result=drawImage.call(this,source,...args);if(sourceIsTainted(source))taintedCanvases.add(this.canvas);return result}}if(typeof prototype.getImageData==='function'){const getImageData=prototype.getImageData;prototype.getImageData=function(...args){if(taintedCanvases.has(this.canvas))throw canvasSecurityError();return getImageData.apply(this,args)}}}
patchCanvasContext(globalThis.CanvasRenderingContext2D?.prototype);patchCanvasContext(globalThis.OffscreenCanvasRenderingContext2D?.prototype);
for(const method of ['toDataURL','toBlob','captureStream']){const native=HTMLCanvasElement.prototype[method];if(typeof native==='function')HTMLCanvasElement.prototype[method]=function(...args){if(taintedCanvases.has(this))throw canvasSecurityError();return native.apply(this,args)}}
for(const Constructor of [globalThis.HTMLCanvasElement,globalThis.OffscreenCanvas]){const prototype=Constructor?.prototype;if(!prototype)continue;for(const property of ['width','height']){const descriptor=Object.getOwnPropertyDescriptor(prototype,property);if(descriptor?.configurable&&descriptor.set)Object.defineProperty(prototype,property,{...descriptor,set:function(value){taintedCanvases.delete(this);return descriptor.set.call(this,value)}})}}
if(typeof OffscreenCanvas!=='undefined'&&typeof OffscreenCanvas.prototype.convertToBlob==='function'){const convertToBlob=OffscreenCanvas.prototype.convertToBlob;OffscreenCanvas.prototype.convertToBlob=function(...args){if(taintedCanvases.has(this))return Promise.reject(canvasSecurityError());return convertToBlob.apply(this,args)}}
if(typeof ImageBitmapRenderingContext!=='undefined'&&typeof ImageBitmapRenderingContext.prototype.transferFromImageBitmap==='function'){const transfer=ImageBitmapRenderingContext.prototype.transferFromImageBitmap;ImageBitmapRenderingContext.prototype.transferFromImageBitmap=function(bitmap){const result=transfer.call(this,bitmap);if(taintedBitmaps.has(bitmap))taintedCanvases.add(this.canvas);return result}}
if(typeof OffscreenCanvas!=='undefined'&&typeof OffscreenCanvas.prototype.transferToImageBitmap==='function'){const transfer=OffscreenCanvas.prototype.transferToImageBitmap;OffscreenCanvas.prototype.transferToImageBitmap=function(...args){const bitmap=transfer.apply(this,args);if(taintedCanvases.has(this))taintedBitmaps.add(bitmap);return bitmap}}
if(typeof createImageBitmap==='function'){const create=window.createImageBitmap.bind(window);window.createImageBitmap=function(source,...args){if(sourceIsTainted(source))return Promise.reject(canvasSecurityError());return create(source,...args)}}
window.bridge={post:function(v){send({type:'bridge',name:'bridge',message:String(v)})}};
window.addEventListener('message',function(e){
const d=e.data;if(!d||d.key!==key)return;
const id=String(d.id||''),p=pending.get(id),remove=function(){if(!p)return;pending.delete(id);p.cleanup()};
if(d.type==='resourceHeaders'){
if(!p||p.settled)return;
const response=d.response||{},status=Number(response.status),noBody=String(response.requestMethod||'').toUpperCase()==='HEAD'||[204,205,304].includes(status);
if(noBody){p.settled=true;p.resolve({__suwayomiStream:true,response,stream:null})}
else{const body=new ReadableStream({start:function(controller){p.stream=controller},pull:function(controller){if(p.pendingChunk){const chunk=p.pendingChunk;p.pendingChunk=null;controller.enqueue(chunk);send({type:'resourceAck',id})}else p.waitingRead=true},cancel:function(){p.abort()}},{highWaterMark:0});p.settled=true;p.resolve({__suwayomiStream:true,response,stream:body})}
return}
if(d.type==='resourceChunk'){
if(!p||!p.stream)return;
try{const chunk=fromBase64(d.body||'');if(p.waitingRead){p.waitingRead=false;p.stream.enqueue(chunk);send({type:'resourceAck',id})}else if(!p.pendingChunk)p.pendingChunk=chunk;else throw new Error('WebView resource stream exceeded its one-chunk window')}
catch(x){try{p.stream.error(x)}catch{}p.abort()}
return}
if(d.type==='resourceEnd'){if(!p)return;try{p.stream?.close()}catch{}remove();return}
if(d.type==='resourceError'){if(!p)return;const error=new TypeError(String(d.error||'WebView resource stream failed'));if(p.stream){try{p.stream.error(error)}catch{}}else if(!p.settled){p.settled=true;p.reject(error)}remove();return}
if(d.type==='resourceComplete'){if(!p)return;remove();if(d.error){if(!p.settled){p.settled=true;p.reject(new TypeError(d.error))}return}if(!p.settled){p.settled=true;p.resolve(d.response)}return}
if(d.type!=='evaluate')return;
void evaluateInPage(d);
})
function evaluationResult(id,value,error){const message={key,type:'evaluation',id};if(error)message.error=String(error&&error.message||error);else{try{message.value=value===undefined?null:JSON.stringify(value)}catch(x){message.error=String(x&&x.message||x)}}parent.postMessage(message,'*')}
function evaluationNonce(){for(const node of document.querySelectorAll('script[nonce]'))if(node.nonce)return node.nonce;return ''}
function evaluationSource(id,marker,script,asExpression){const idCode=JSON.stringify(id),markerCode=JSON.stringify(marker),valueCode=asExpression?'const value=(function(){return ('+script+'\\n)}).call(window);':'(function(){'+script+'\\n}).call(window);const value=undefined;';return '(function(){const state=window['+markerCode+'];try{'+valueCode+'state.ran=true;Promise.resolve(value).then(function(result){parent.postMessage({key:'+JSON.stringify(key)+',type:"evaluation",id:'+idCode+',value:result===undefined?null:JSON.stringify(result)},"*")},function(error){parent.postMessage({key:'+JSON.stringify(key)+',type:"evaluation",id:'+idCode+',error:String(error&&error.message||error)},"*")})}catch(error){state.ran=true;parent.postMessage({key:'+JSON.stringify(key)+',type:"evaluation",id:'+idCode+',error:String(error&&error.message||error)},"*")}})()'}
function appendInlineEvaluation(source,nonce,marker){const node=document.createElement('script');if(nonce)node.nonce=nonce;node.textContent=source;(document.head||document.documentElement).appendChild(node);node.remove();return Boolean(window[marker]?.ran)}
async function appendBlobEvaluation(source,nonce,marker){let url='';try{url=URL.createObjectURL(new Blob([source],{type:'text/javascript'}));const node=document.createElement('script');if(nonce)node.nonce=nonce;node.src=url;const loaded=new Promise(resolve=>{let settled=false;const done=()=>{if(settled)return;settled=true;clearTimeout(timer);resolve()};node.addEventListener('load',done,{once:true});node.addEventListener('error',done,{once:true});const timer=setTimeout(done,1500)});(document.head||document.documentElement).appendChild(node);await loaded;node.remove();return Boolean(window[marker]?.ran)}catch{return Boolean(window[marker]?.ran)}finally{if(url)URL.revokeObjectURL(url)}}
async function runEvaluationSource(source,nonce,marker){try{if(appendInlineEvaluation(source,nonce,marker))return true}catch{}try{if(await appendBlobEvaluation(source,nonce,marker))return true}catch{}return Boolean(window[marker]?.ran)}
async function evaluateInPage(data){const id=String(data.id||'');if(!id)return;const marker='__suwayomi_eval_'+key+'_'+id;window[marker]={ran:false};const nonce=evaluationNonce(),script=String(data.script||'');try{const expression=evaluationSource(id,marker,script.replace(/\\s*;+\\s*$/,''),true);if(await runEvaluationSource(expression,nonce,marker))return;const statements=evaluationSource(id,marker,script,false);if(await runEvaluationSource(statements,nonce,marker))return;evaluationResult(id,null,new Error('The page Content Security Policy blocked WebView JavaScript evaluation, or the script is syntactically invalid.'))}finally{delete window[marker]}}
})()</script>`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/(<head\b[^>]*>)/i, `$1<base href="${base}">${policy}${prelude}`);
  return `<!doctype html><head><base href="${base}">${policy}${prelude}</head><body>${html}</body>`;
}

function escapeAttribute(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function decodeResourceBytes(value) {
  const binary = atob(value);
  return Uint8Array.from(binary, character => character.charCodeAt(0));
}

function getIntegrityPolicy(node, url, baseUrl) {
  if (!node.hasAttribute('integrity')) return null;
  const documentOrigin = new URL(baseUrl).origin;
  const hasCrossOriginAttribute = node.hasAttribute('crossorigin');
  const crossOriginMode = (node.getAttribute('crossorigin') || '').trim().toLowerCase();
  return {
    metadata: node.getAttribute('integrity'),
    requiresCors: url.origin !== documentOrigin,
    request: {
      corsMode: hasCrossOriginAttribute,
      requireCors: true,
      credentialsMode: crossOriginMode === 'use-credentials' ? 'include' : 'same-origin',
      requestOrigin: documentOrigin,
    },
  };
}
