import { suffixRules, suffixExceptions } from './public-suffix-data.mjs';
const rules = new Set(suffixRules.split('\n')), exceptions = new Set(suffixExceptions.split('\n'));

export function registrableDomain(value) {
  let host;
  try { host = new URL('https://' + String(value)).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
  if (/[:*%]/.test(host) || /^(?:\d+\.){3}\d+$/.test(host) || host === 'localhost' || host.endsWith('.localhost')) return null;
  const labels = host.split('.');
  if (labels.length < 2) return null;
  let suffixLength = 1; // PSL implicit wildcard for unknown TLDs.
  for (let i = 0; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.');
    if (exceptions.has(suffix)) { suffixLength = labels.length - i - 1; break; }
    if (rules.has(suffix)) suffixLength = Math.max(suffixLength, labels.length - i);
    if (i > 0 && rules.has('*.' + suffix)) suffixLength = Math.max(suffixLength, labels.length - i + 1);
  }
  return labels.length > suffixLength ? labels.slice(-suffixLength - 1).join('.') : null;
}
