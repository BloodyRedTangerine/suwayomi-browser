/**
 * Reproduce Chromium's default low-entropy User-Agent Client Hints for a
 * brokered WebView request. Never ask for high-entropy values or synthesize
 * brand/platform strings when the browser does not expose them.
 */
export function defaultUserAgentClientHints(userAgentData = globalThis.navigator?.userAgentData) {
  if (!userAgentData || !Array.isArray(userAgentData.brands) || typeof userAgentData.mobile !== 'boolean') return [];
  const brands = userAgentData.brands
    .filter(item => typeof item?.brand === 'string' && item.brand && typeof item.version === 'string' && item.version)
    .map(item => `${JSON.stringify(item.brand)};v=${JSON.stringify(item.version)}`);
  if (!brands.length) return [];
  const hints = [['Sec-CH-UA', brands.join(', ')], ['Sec-CH-UA-Mobile', userAgentData.mobile ? '?1' : '?0']];
  if (typeof userAgentData.platform === 'string' && userAgentData.platform) hints.push(['Sec-CH-UA-Platform', JSON.stringify(userAgentData.platform)]);
  return hints;
}

export function addMissingClientHintHeaders(headers = [], hints = defaultUserAgentClientHints()) {
  const result = headers.map(pair => [String(pair[0]), String(pair[1])]);
  const present = new Set(result.map(([name]) => name.toLowerCase()));
  for (const [name, value] of hints) if (!present.has(name.toLowerCase())) result.push([name, value]);
  return result;
}
