import { permissionPattern } from './permissions.mjs';

export function permissionDenials(error) {
  return [...new Set([...(Array.isArray(error?.deniedOrigins) ? error.deniedOrigins : []), error?.deniedOrigin]
    .filter(origin => typeof origin === 'string' && permissionPattern(origin) === origin))];
}

// Never infer retry authority from an arbitrary error string or old stderr.
// Require a broker denial recorded for this command and its message in the
// actual Java exception message (including wrapped IOException causes).
export function matchingPermissionDenials(message, records) {
  return [...new Set(records.filter(record => record.message && String(message).includes(record.message))
    .flatMap(record => permissionDenials(record)))];
}
