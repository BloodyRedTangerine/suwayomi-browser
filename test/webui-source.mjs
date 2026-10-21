// Locates the patched Suwayomi-WebUI source used by the tests that audit WebUI call sites.
// Set SUWAYOMI_WEBUI_SOURCE to the checkout; tests skip when it is unavailable.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const configured = process.env.SUWAYOMI_WEBUI_SOURCE;
export const webuiRoot = configured
  ? (configured.endsWith('/') ? configured : configured + '/')
  : fileURLToPath(new URL('../../../Suwayomi-WebUI/', import.meta.url));
export const webuiUrl = pathToFileURL(webuiRoot);
export const webuiAvailable = existsSync(join(webuiRoot, 'package.json')) && existsSync(join(webuiRoot, 'src'));
export const webuiSkip = webuiAvailable ? false : 'Suwayomi-WebUI source not available (set SUWAYOMI_WEBUI_SOURCE)';

/** Recursive file listing (replaces an external `rg --files`). `accept(path)` filters by absolute path. */
export function listFiles(directory, accept = () => true) {
  const found = [];
  const visit = current => {
    for (const entry of readdirSync(current, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1)) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') visit(path); }
      else if (accept(path)) found.push(path);
    }
  };
  visit(directory);
  return found;
}
