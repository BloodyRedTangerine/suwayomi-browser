export function normalizeSignerFingerprint(value, label = 'signer fingerprint') {
  const normalized = String(value || '').trim().replaceAll(':', '').toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error(`Invalid ${label}`);
  return normalized;
}

export function assertSignerTrust(signature, {
  packageName = 'extension',
  repositoryFingerprint = '',
  existingFingerprint = '',
} = {}) {
  const fingerprints = [...new Set((signature?.fingerprints || []).map(value => normalizeSignerFingerprint(value)))];
  if (fingerprints.length !== 1) throw new Error(`${packageName} must have exactly one distinct signing certificate`);
  const actual = fingerprints[0];
  if (repositoryFingerprint) {
    const expected = normalizeSignerFingerprint(repositoryFingerprint, 'repository signing fingerprint');
    if (actual !== expected)
      throw new Error(`${packageName} signer fingerprint ${actual} does not match repository signing key ${expected}`);
  }
  if (existingFingerprint) {
    const expected = normalizeSignerFingerprint(existingFingerprint, 'previous signer fingerprint');
    if (actual !== expected)
      throw new Error(`${packageName} signer fingerprint changed from ${expected} to ${actual}; uninstall first to trust a new signer`);
  }
  return actual;
}
