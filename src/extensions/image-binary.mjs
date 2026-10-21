// This is the guest JVM's disposable, memory-only filesystem, NOT host storage.
// Pixel buffers never enter JSON, durable snapshots, HTTP or extension messages.
const root = '/cache/image-codec';
const regular = mode => (mode & 0o170000) === 0o100000;
const directory = mode => (mode & 0o170000) === 0o040000;
const maxBytes = 32 * 1024 * 1024;
export function createImageBinaryChannel(FS, uuid = () => crypto.randomUUID()) {
  function parent() {
    if (!directory(FS.lstat('/cache').mode)) throw new Error('Image cache must be a real directory');
    try { FS.lstat(root); } catch { FS.mkdir(root); }
    if (!directory(FS.lstat(root).mode)) throw new Error('Image cache must not be a symlink');
  }
  function path(value) {
    if (typeof value !== 'string' || !/^\/cache\/image-codec\/(?:jvm|js)-image-[A-Za-z0-9-]+\.bin$/.test(value)) throw new Error('Invalid local image buffer path');
    parent(); return value;
  }
  parent();
  return {
    read(value, limit = maxBytes) {
      value = path(value);
      const stat = FS.lstat(value);
      if (!regular(stat.mode) || !Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > Math.min(limit,maxBytes)) throw new Error('Invalid local image buffer');
      const bytes = FS.readFile(value);
      if (!(bytes instanceof Uint8Array) || bytes.length !== stat.size) throw new Error('Local image buffer changed');
      return bytes;
    },
    write(bytes) {
      if (!(bytes instanceof Uint8Array) && !(bytes instanceof Uint8ClampedArray)) throw new TypeError('Local image bytes required');
      if (!bytes.length || bytes.length > maxBytes) throw new Error('Local image buffer exceeds limits');
      const value = path(root + '/js-image-' + uuid() + '.bin');
      let exists = true; try { FS.lstat(value); } catch { exists = false; }
      if (exists) throw new Error('Local image buffer collision');
      FS.writeFile(value, bytes); return value;
    },
  };
}
