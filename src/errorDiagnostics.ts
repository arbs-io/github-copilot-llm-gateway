/**
 * Human-friendly rephrasings for the raw error messages that the model-fetch
 * path surfaces. Extracted into a standalone module so it can be unit-tested
 * without pulling in the `vscode` runtime.
 */

/**
 * Translate a raw fetch-models error message into something the user can act on.
 * Most common failures are easy to diagnose from the text alone — surface the
 * remediation inline so the user doesn't have to dig through the output panel.
 */
export function diagnoseModelFetchError(message: string): string {
  const lower = message.toLowerCase();
  // Check specific HTTP status codes first, since the wrapper text often
  // contains generic substrings like "failed to fetch" that would otherwise
  // short-circuit the more specific hints.
  if (lower.includes('404')) {
    return `${message}\nIf your Server URL already includes "/v1", remove that suffix — the extension appends it automatically.`;
  }
  if (lower.includes('401') || lower.includes('403')) {
    return `${message}\nAuthentication failed. Paste just the key (no leading "Bearer ") into the API Key setting.`;
  }
  if (lower.includes('abort')) {
    return `${message}\nThe request was aborted. If your server is slow to start, increase the requestTimeout setting.`;
  }
  if (lower.includes('econnrefused') || lower.includes('failed to fetch')) {
    return `${message}\nIs your inference server running and reachable at the configured URL?`;
  }
  return message;
}
