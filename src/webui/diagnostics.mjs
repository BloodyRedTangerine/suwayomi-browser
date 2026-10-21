const recentErrors = [];
const MAX_ERROR_BUFFER = 100;
const EXPORTED_ERROR_COUNT = 20;

function safeName(value) {
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/.test(String(value || '')) ? String(value) : 'Error';
}

function privateStrings(values, limit = Infinity) {
  const unique = new Set();
  for (const value of values || []) {
    if (typeof value !== 'string') continue;
    const normalized = value.trim();
    if (normalized.length >= 3 && normalized.length <= 4096) unique.add(normalized);
    if (unique.size >= limit) break;
  }
  return [...unique].sort((left, right) => right.length - left.length);
}

function diagnosticRedactor(sensitiveValues = []) {
  const secrets = privateStrings(sensitiveValues);
  return value => {
    let text = String(value ?? '').slice(0, 4096);
    text = text.replace(/\b(?:https?|file|chrome-extension|moz-extension):\/\/[^\s"'<>]+/gi, '[URL redacted]');
    text = text.replace(/\b(headers?|cookie|set-cookie|authorization|proxy-authorization|password|secret|api[_-]?key|x-[\w-]*token)\s*:\s*[^\r\n]*/gi, '$1: [redacted]');
    text = text.replace(/\b(cookie|set-cookie|authorization|proxy-authorization|password|secret|api[_-]?key|x-[\w-]*token)\s*=\s*[^\s,;&]+/gi, '$1=[redacted]');
    text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]');
    text = text.replace(/\b(session(?:id)?|csrf(?:token)?|auth(?:orization)?|token|api[_-]?key|password|secret)\s*=\s*[^\s,;&]+/gi, '$1=[redacted]');
    text = text.replace(/[?&][^\s"'<>]+/g, '?[query redacted]');
    text = text.replace(/(^|[\s"'(=])\/(?:[A-Za-z0-9._~%+-]+\/?)+(?:\?[^\s"'<>]*)?/g, '$1[path redacted]');
    let lower = text.toLowerCase();
    for (const secret of secrets) {
      if (!lower.includes(secret.toLowerCase())) continue;
      text = text.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'giu'), '[redacted]');
      lower = text.toLowerCase();
    }
    return text.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 500);
  };
}

export function redactDiagnosticText(value, sensitiveValues = []) {
  return diagnosticRedactor(sensitiveValues)(value);
}

export function recordBrowserDiagnosticError(error, sensitiveValues = []) {
  const message = String(error?.message ?? error ?? 'Unknown error');
  const stack = typeof error?.stack === 'string' ? error.stack.split(/\r?\n/).slice(1, 4) : [];
  const redact = diagnosticRedactor(privateStrings(sensitiveValues, 2000));
  recentErrors.push({
    time: new Date().toISOString(),
    name: safeName(error?.name),
    message: redact(message),
    stack: stack.map(line => redact(line.slice(0, 1000))),
  });
  if (recentErrors.length > MAX_ERROR_BUFFER) recentErrors.splice(0, recentErrors.length - MAX_ERROR_BUFFER);
}

export function clearBrowserDiagnosticErrors() {
  recentErrors.length = 0;
}

function browserInfo(navigatorRef = globalThis.navigator) {
  const hints = navigatorRef?.userAgentData;
  const brands = Array.isArray(hints?.brands) ? hints.brands : [];
  const preferred = brands.find(brand => /edge/i.test(brand.brand))
    || brands.find(brand => /opera/i.test(brand.brand))
    || brands.find(brand => /brave/i.test(brand.brand))
    || brands.find(brand => /chrome/i.test(brand.brand))
    || brands.find(brand => /chromium/i.test(brand.brand));
  const ua = String(navigatorRef?.userAgent || '');
  let name = preferred?.brand || 'Unknown';
  let version = preferred?.version || '';
  if (!preferred) {
    const candidates = [
      ['Edge', /Edg(?:A|iOS)?\/([\d.]+)/], ['Opera', /(?:OPR|Opera)\/([\d.]+)/],
      ['Chrome', /Chrome\/([\d.]+)/], ['Firefox', /Firefox\/([\d.]+)/], ['Safari', /Version\/([\d.]+).*Safari/],
    ];
    for (const [candidate, pattern] of candidates) {
      const match = ua.match(pattern);
      if (match) { name = candidate; version = match[1]; break; }
    }
  }
  return { name: String(name).slice(0, 60), version: String(version).slice(0, 40) || 'unknown' };
}

function osFamily(navigatorRef = globalThis.navigator) {
  const raw = String(navigatorRef?.userAgentData?.platform || navigatorRef?.platform || navigatorRef?.userAgent || '').toLowerCase();
  if (/android/.test(raw)) return 'Android';
  if (/iphone|ipad|ipod|ios/.test(raw)) return 'iOS';
  if (/cros|chrome os/.test(raw)) return 'ChromeOS';
  if (/windows|win32|win64/.test(raw)) return 'Windows';
  if (/mac|darwin/.test(raw)) return 'macOS';
  if (/linux|x11/.test(raw)) return 'Linux';
  return 'Unknown';
}

function shortFingerprint(value) {
  const fingerprint = String(value || '').replace(/^jar-v1:/i, '').replace(/[^a-f\d]/gi, '').toLowerCase();
  return /^[a-f\d]{16,}$/.test(fingerprint) ? fingerprint.slice(0, 12) : 'unpublished';
}

function countValue(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
}

export function createBrowserDiagnostics(data) {
  const redact = diagnosticRedactor(data.sensitiveValues || []);
  const queueStates = { QUEUED: 0, DOWNLOADING: 0, ERROR: 0, UNKNOWN: 0 };
  for (const state of Object.values(data.queueStates || {})) {
    const key = ['QUEUED', 'DOWNLOADING', 'ERROR'].includes(state) ? state : 'UNKNOWN';
    queueStates[key]++;
  }
  const installedExtensions = (data.installedExtensions || []).map(record => ({
    package: redact(record.packageName),
    version: redact(record.version),
    versionCode: redact(record.versionCode),
    verification: ['verified', 'pre-0.3.0'].includes(record.verification) ? record.verification : 'unknown',
  }));
  const repositories = (data.repositories || []).map(repository => ({
    name: redact(repository.name || 'Unnamed repository'),
    signerFingerprint: shortFingerprint(repository.signingKey),
  }));
  return JSON.stringify({
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    extension: {
      version: redact(data.extensionVersion || 'unknown'),
      id: redact(data.extensionId || 'unknown'),
    },
    browser: browserInfo(data.navigator),
    osFamily: osFamily(data.navigator),
    installedExtensions,
    repositories,
    storage: {
      usageBytes: data.storage?.usage == null ? null : countValue(data.storage.usage),
      quotaBytes: data.storage?.quota == null ? null : countValue(data.storage.quota),
      persisted: typeof data.storage?.persisted === 'boolean' ? data.storage.persisted : null,
      cachedPageCount: countValue(data.storage?.cachedPageCount),
      cachedPageBlobBytes: countValue(data.storage?.cachedPageBlobBytes),
      libraryDatabaseBytes: countValue(data.storage?.libraryDatabaseBytes),
    },
    counts: {
      mangas: countValue(data.counts?.mangas),
      chapters: countValue(data.counts?.chapters),
      downloadQueueByState: queueStates,
    },
    recentErrors: recentErrors.slice(-EXPORTED_ERROR_COUNT).map(error => ({
      time: error.time,
      name: error.name,
      message: redact(error.message),
      stack: error.stack.map(line => redact(line)),
    })),
  }, null, 2);
}
