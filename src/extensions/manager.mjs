import { ExtensionRuntime } from './runtime.mjs';
import { inspectExtension } from './package.mjs';
import { verifyExtensionSignature } from './signature.mjs';
import { assertSignerTrust } from './trust-policy.mjs';

const prefix = 'extension:';
const preferencesKey = 'jvm:preferences';

export class ExtensionManager {
  constructor(store, options = {}) {
    this.store = store;
    this.options = options;
    this.runtime = new ExtensionRuntime(options);
    this.loaded = new Set();
    this.queue = Promise.resolve();
    this.restored = false;
  }
  run(task) {
    const result = this.queue.then(() => this.store.exclusive('runtime', async () => {
      const current = await this.state();
      if (this.runtime.closed || (this.observedState !== undefined && this.observedState !== current)) this.resetRuntime();
      this.observedState = current;
      try { return await task(); }
      catch (error) { this.resetRuntime(); throw error; }
      finally { this.observedState = await this.state(); }
    }));
    this.queue = result.catch(() => {});
    return result;
  }
  async state() {
    const installed = (await this.store.getAllByPrefix('settings', prefix)).map(record => [
      record.packageName,
      record.revision || record.installedAt || '',
      record.versionCode || '',
      record.jar?.size || 0,
      record.archive?.size || 0,
      record.signerFingerprint || '',
      record.verification || '',
    ]).sort((a, b) => a[0].localeCompare(b[0]));
    const state = await this.store.get('settings', preferencesKey);
    return JSON.stringify([state?.value ?? null, state?.files?.fingerprint ?? null, installed]);
  }
  resetRuntime() {
    // Never persist this VM here: another tab's newer snapshot is authoritative.
    this.runtime.dispose();
    this.runtime = new ExtensionRuntime(this.options);
    this.loaded.clear(); this.restored = false;
  }
  async restore() {
    if (this.restored) return;
    const saved = await this.store.get('settings', preferencesKey);
    if (saved) await this.runtime.request('state', { restore: saved });
    this.restored = true;
  }
  async persist() {
    if (!this.restored || this.runtime.closed) return;
    const snapshot = await this.runtime.request('state');
    if (typeof snapshot?.preferences !== 'string' || !snapshot.files) throw new Error('Invalid JVM state checkpoint');
    await this.store.put('settings', { key: preferencesKey, value: snapshot.preferences, files: snapshot.files });
  }
  async list() {
    const records = await this.store.getAllByPrefix('settings', prefix);
    for (const record of records) {
      let changed = false;
      if (record.verification === 'verified' && !record.signerFingerprint)
        throw new Error(`Verified extension ${record.packageName} is missing its signer fingerprint`);
      if (!record.signerFingerprint && record.verification !== 'pre-0.3.0') {
        record.verification = 'pre-0.3.0';
        changed = true;
      }
      if (!record.contentWarning) {
        const metadata = inspectExtension(new Uint8Array(await record.jar.arrayBuffer()));
        record.contentWarning = metadata.contentWarning;
        changed = true;
      }
      if (changed) await this.store.put('settings', record);
    }
    return records;
  }
  install(file, {
    expectedPackage,
    expectedVersion,
    storeIndexUrl = null,
    repositoryFingerprint = '',
    repositoryName = '',
    manualImport = !storeIndexUrl,
  } = {}) {
    return this.run(async () => {
      await this.restore();
      if (file.size > 64 * 1024 * 1024) throw new Error('Extension archive exceeds the 64 MiB browser import limit.');
      const bytes = new Uint8Array(await file.arrayBuffer());
      let metadata = inspectExtension(bytes);
      if (metadata.needsBinaryManifest) metadata = inspectExtension(bytes, await this.runtime.manifest(bytes));
      if (expectedPackage && metadata.packageName !== expectedPackage) throw new Error('Downloaded extension package does not match its repository entry');
      if (expectedVersion && metadata.versionCode !== expectedVersion) throw new Error('Downloaded extension version does not match its repository entry');

      const signature = await verifyExtensionSignature(bytes, {
        format: metadata.format,
        jarVerifier: archive => this.runtime.verifyJarSignature(archive),
      });
      const existing = await this.store.get('settings', prefix + metadata.packageName);
      const signerFingerprint = assertSignerTrust(signature, {
        packageName: metadata.packageName,
        repositoryFingerprint,
        existingFingerprint: existing?.signerFingerprint || '',
      });
      const needsConfirmation = manualImport || (!repositoryFingerprint && !existing?.signerFingerprint);
      if (needsConfirmation) {
        const confirmer = this.options.confirmSigner || (message =>
          typeof globalThis.confirm === 'function' ? globalThis.confirm(message) : false);
        if (typeof confirmer !== 'function') throw new Error('Explicit signer confirmation is unavailable; extension was not installed');
        const context = manualImport
          ? 'This is a manual import with no repository identity.'
          : `Repository "${repositoryName || storeIndexUrl}" does not publish a signing fingerprint.`;
        const message = [
          `Install ${metadata.name} (${metadata.packageName})?`,
          `The ${signature.scheme} archive signature is valid.`,
          `Signer SHA-256: ${signerFingerprint}`,
          context,
          'This signer will be pinned and required for future updates.',
        ].join('\n');
        if (!await confirmer(message, { metadata, signature, signerFingerprint, manualImport, storeIndexUrl }))
          throw new Error('Installation cancelled: signer confirmation was declined');
      }

      try {
        const loaded = await this.runtime.install(bytes, metadata.classes, metadata.format);
        const record = {
          key: prefix + metadata.packageName,
          ...metadata,
          storeIndexUrl,
          signatureScheme: signature.scheme,
          signerFingerprint,
          verifiedAt: new Date().toISOString(),
          verification: 'verified',
          archive: new Blob([bytes], { type: file.type || 'application/octet-stream' }),
          archiveFormat: metadata.format,
          sources: loaded.sources,
          jar: new Blob([loaded.jar], { type: 'application/java-archive' }),
          revision: crypto.randomUUID(),
          installedAt: new Date().toISOString(),
        };
        await this.store.put('settings', record);
        this.loaded.add(record.packageName);
        return record;
      } finally { await this.persist(); }
    });
  }
  async loadSources() {
    await this.restore();
    for (const record of await this.list()) {
      if (this.loaded.has(record.packageName)) continue;
      let bytes, classes, format = 'jar', metadata = null;
      if (record.signerFingerprint || record.archive) {
        if (!record.signerFingerprint || !record.archive || record.verification !== 'verified')
          throw new Error(`Verified extension ${record.packageName} is missing its signed archive or trust metadata; reinstall it`);
        bytes = new Uint8Array(await record.archive.arrayBuffer());
        metadata = inspectExtension(bytes);
        if (metadata.needsBinaryManifest) metadata = inspectExtension(bytes, await this.runtime.manifest(bytes));
        if (metadata.packageName !== record.packageName)
          throw new Error(`Stored archive package does not match installed extension ${record.packageName}`);
        const signature = await verifyExtensionSignature(bytes, {
          format: metadata.format,
          jarVerifier: archive => this.runtime.verifyJarSignature(archive),
        });
        assertSignerTrust(signature, { packageName: record.packageName, existingFingerprint: record.signerFingerprint });
        classes = metadata.classes;
        format = metadata.format;
      } else {
        // Pre-0.3.0 records contain only the code that was already installed.
        // Keep them usable, but label them unverified and require signed bytes
        // for any future replacement or update.
        bytes = new Uint8Array(await record.jar.arrayBuffer());
        classes = record.classes;
      }
      const loaded = await this.runtime.install(bytes, classes, format);
      await this.store.put('settings', {
        ...record,
        ...(metadata ? { classes: metadata.classes, format: metadata.format } : {}),
        sources: loaded.sources,
        jar: new Blob([loaded.jar], { type: 'application/java-archive' }),
      });
      this.loaded.add(record.packageName);
    }
  }
  ready() { return this.run(async () => { try { await this.loadSources(); } finally { await this.persist(); } }); }
  async sources() { return (await this.list()).flatMap(record => record.sources.map(source => ({ ...source, packageName: record.packageName }))); }
  call(sourceId, operation, args = {}) {
    return this.run(async () => {
      try {
        await this.loadSources();
        return await this.runtime.call(sourceId, operation, args);
      } finally { await this.persist(); }
    });
  }
  restart() {
    return this.run(async () => {
      await this.persist();
      this.resetRuntime();
    });
  }
  uninstall(packageName) {
    return this.run(async () => {
      if (!await this.store.get('settings', prefix + packageName)) throw new Error('Extension is not installed');
      await this.persist();
      // Drop classloaders and old source registrations, including sources whose
      // IDs changed during upgrades. Library records and preferences are kept.
      this.resetRuntime();
      await this.store.delete('settings', prefix + packageName);
    });
  }
}
