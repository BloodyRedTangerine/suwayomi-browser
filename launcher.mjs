const api = globalThis.browser ?? globalThis.chrome;
const status = document.querySelector('#status');

try {
  const response = await api.runtime.sendMessage({ type: 'suwayomi:open-app' });
  if (!response?.ok) status.textContent = `Could not open Suwayomi Browser: ${response?.error ?? 'unknown error'}. Close this tab and try again.`;
} catch (error) {
  status.textContent = `Could not open Suwayomi Browser: ${error?.message ?? error}. Close this tab and try again.`;
}
