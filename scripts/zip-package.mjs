// Usage: node scripts/zip-package.mjs <package directory> <new zip file>
// Deterministic release archive: entries sorted by name, one fixed timestamp (SOURCE_DATE_EPOCH), no directory entries,
// no extra fields or attributes. Building the same directory twice, anywhere, gives the same bytes.
import { readdir, readFile, writeFile, stat } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { createZip } from './deterministic-zip.mjs';
import { sourceDateEpoch } from './paths.mjs';

const [directory, archive] = process.argv.slice(2).map(value => value && resolve(value));
if (!directory || !archive) throw new Error('Usage: zip-package.mjs <package directory> <new zip file>');
await stat(archive).then(() => { throw new Error('Refusing to overwrite ' + archive); }, error => { if (error.code !== 'ENOENT') throw error; });
const entries = [];
async function visit(current) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isDirectory()) await visit(path);
    else if (entry.isFile()) entries.push({ name: relative(directory, path).split(sep).join('/'), data: await readFile(path) });
    else throw new Error('Unsupported entry (not a regular file): ' + path);
  }
}
await visit(directory);
if (!entries.some(entry => entry.name === 'manifest.json')) throw new Error('manifest.json must be at the archive root');
await writeFile(archive, createZip(entries, { epochSeconds: sourceDateEpoch, level: 9 }), { flag: 'wx' });
console.log(`Wrote ${archive} (${entries.length} entries)`);
