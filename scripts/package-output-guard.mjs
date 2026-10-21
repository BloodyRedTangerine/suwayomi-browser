import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const PRIVATE_KEY_MARKER = /-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/;

export async function assertNoPrivateKeyMaterial(directory) {
  const offenders = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) {
        await visit(child);
        continue;
      }
      if (!entry.isFile()) continue;
      if (/\.(?:pem|key|p8|p12)$/i.test(entry.name)) {
        offenders.push(relative(directory, child));
        continue;
      }
      const bytes = await readFile(child);
      if (PRIVATE_KEY_MARKER.test(bytes.toString('ascii'))) offenders.push(relative(directory, child));
    }
  }
  await visit(directory);
  if (offenders.length) throw new Error(`Refusing to package private key material: ${offenders.join(', ')}`);
}
