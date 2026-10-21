// Shared locations and pinned inputs for the build scripts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

export const root = fileURLToPath(new URL('../', import.meta.url));
/** Working area for upstream clones and downloads. Override with BROWSER_BUILD_CACHE. */
export const cacheRoot = resolve(root, process.env.BROWSER_BUILD_CACHE || '.cache');
export const upstream = JSON.parse(readFileSync(resolve(root, 'UPSTREAM.json'), 'utf8'));
/** Seconds since the epoch used for every timestamp written into build outputs (declared in the tree). */
export const sourceDateEpoch = Number(process.env.SOURCE_DATE_EPOCH || readFileSync(resolve(root, 'SOURCE_DATE_EPOCH'), 'utf8').trim());
if (!Number.isInteger(sourceDateEpoch) || sourceDateEpoch < 315532800) throw new Error('SOURCE_DATE_EPOCH must be an integer after 1980-01-01');
