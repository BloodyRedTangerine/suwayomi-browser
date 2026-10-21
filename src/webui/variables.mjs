/** Match JSON omission semantics while retaining multipart Upload scalars. */
export function normalizeVariables(value) {
  if (Array.isArray(value)) return value.map(item => item === undefined ? null : normalizeVariables(item));
  if (value && typeof value === 'object' && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)) {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined).map(([key, item]) => [key, normalizeVariables(item)]));
  }
  return value;
}
