// Only the guest's Android files directory is durable. Never snapshot runtime
// classes, imported archives, temporary files or the disposable cache directory.
export const FILESYSTEM_LIMITS = Object.freeze({ bytes: 32 * 1024 * 1024, entries: 10000, depth: 64 });
const root = '/data';
const kind = mode => mode & 0o170000;
function validPath(path) {
  if (typeof path !== 'string' || path.length > 4096 || path.includes('\0') || !path.startsWith(root + '/')) throw new Error('Invalid persistent JVM path');
  const segments = path.slice(root.length + 1).split('/');
  if (segments.length > FILESYSTEM_LIMITS.depth || segments.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid persistent JVM path');
}
export function validateFilesystem(snapshot) {
  if (snapshot?.version !== 1 || !Array.isArray(snapshot.entries) || snapshot.entries.length > FILESYSTEM_LIMITS.entries) throw new Error('Invalid persistent JVM filesystem snapshot');
  const paths = new Map(); let bytes = 0;
  for (const entry of snapshot.entries) {
    validPath(entry.path);
    if (paths.has(entry.path) || !['file', 'dir'].includes(entry.type) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || !Number.isSafeInteger(entry.mtime) || entry.mtime < 0 || entry.mtime > Number.MAX_SAFE_INTEGER / 1000) throw new Error('Invalid persistent JVM filesystem entry');
    if (entry.type === 'file') {
      if (!(entry.bytes instanceof Uint8Array)) throw new Error('Invalid persistent JVM file bytes');
      bytes += entry.bytes.byteLength;
      if (bytes > FILESYSTEM_LIMITS.bytes) throw new Error('Persistent JVM files exceed 32 MiB');
    }
    paths.set(entry.path, entry.type);
  }
  for (const path of paths.keys()) {
    const parent = path.slice(0, path.lastIndexOf('/'));
    if (parent !== root && paths.get(parent) !== 'dir') throw new Error('Persistent JVM file has no directory parent');
  }
  return snapshot;
}
export async function captureFilesystem(FS) {
  if (kind(FS.lstat(root).mode) !== 0o040000) throw new Error('Persistent JVM root must be a real directory');
  const entries = []; let total = 0;
  const walk = path => {
    for (const name of FS.readdir(path).filter(name => name !== '.' && name !== '..').sort()) {
      const child = path + '/' + name; validPath(child);
      const info = FS.lstat(child), type = kind(info.mode);
      if (type !== 0o040000 && type !== 0o100000) throw new Error('Persistent JVM files currently require regular files/directories (no symlinks or special files)');
      if (entries.length >= FILESYSTEM_LIMITS.entries) throw new Error('Too many persistent JVM filesystem entries');
      const entry = { path: child, type: type === 0o040000 ? 'dir' : 'file', mode: info.mode & 0o777, mtime: info.mtime };
      entries.push(entry);
      if (entry.type === 'dir') walk(child);
      else {
        total += info.size;
        if (total > FILESYSTEM_LIMITS.bytes) throw new Error('Persistent JVM files exceed 32 MiB');
        entry.bytes = FS.readFile(child);
      }
    }
  };
  walk(root); validateFilesystem({ version: 1, entries });
  const fingerprint = [];
  for (const entry of entries) {
    const digest = entry.type === 'file' ? [...new Uint8Array(await crypto.subtle.digest('SHA-256', entry.bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('') : null;
    fingerprint.push([entry.path, entry.type, entry.mode, entry.mtime, digest]);
  }
  return { version: 1, entries, fingerprint: JSON.stringify(fingerprint) };
}
export function restoreFilesystem(FS, snapshot) {
  validateFilesystem(snapshot); // Validate all paths before making any writes.
  if (kind(FS.lstat(root).mode) !== 0o040000) throw new Error('Persistent JVM root must be a real directory');
  const entries = [...snapshot.entries].sort((a, b) => a.path.split('/').length - b.path.split('/').length);
  if (FS.readdir(root).some(name => name !== '.' && name !== '..')) throw new Error('Persistent JVM files can only be restored into a fresh filesystem');
  for (const entry of entries) {
    if (entry.type === 'dir') FS.mkdir(entry.path);
    else FS.writeFile(entry.path, entry.bytes);
  }
  // Apply restrictive permissions and directory timestamps only after creating
  // their children. Emscripten stat exposes seconds; utime accepts milliseconds.
  for (const entry of entries.reverse()) {
    FS.chmod(entry.path, entry.mode);
    FS.utime(entry.path, entry.mtime * 1000, entry.mtime * 1000);
  }
}
