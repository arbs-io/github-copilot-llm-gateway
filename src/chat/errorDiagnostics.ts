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
  // A client-side timeout (RequestTimeoutError) carries the budget in ms, so
  // it's checked before the status codes to keep a value like 404 ms from
  // reading as an HTTP status.
  if (lower.includes('did not respond within')) {
    return `${message}\nThe request timed out. If your server is slow to start, increase the requestTimeout setting.`;
  }
  // Check specific HTTP status codes first, since the wrapper text often
  // contains generic substrings like "failed to fetch" that would otherwise
  // short-circuit the more specific hints. Word boundaries keep numbers such
  // as ports or millisecond values (e.g. 40100) from matching.
  if (/\b404\b/.test(lower)) {
    return `${message}\nIf your Server URL already includes "/v1", remove that suffix — the extension appends it automatically.`;
  }
  if (/\b40[13]\b/.test(lower)) {
    return `${message}\nAuthentication failed. Paste just the key (no leading "Bearer ") into the API Key setting.`;
  }
  if (lower.includes('abort')) {
    return `${message}\nThe request was aborted. If your server is slow to start, increase the requestTimeout setting.`;
  }
  if (lower.includes('enotfound') || lower.includes('eai_again')) {
    return `${message}\nThe hostname could not be resolved (DNS). If VS Code is running in a Dev Container, WSL, or a Remote-SSH session, that environment may not resolve internal hostnames the way your local machine does — try the server's IP address, or verify the host is resolvable from where the extension runs.`;
  }
  if (lower.includes('etimedout') || lower.includes('ehostunreach') || lower.includes('enetunreach')) {
    return `${message}\nThe host resolved but did not respond (timeout/unreachable). Check the port, any firewall or VPN, and that the machine running VS Code can route to the server.`;
  }
  if (lower.includes('econnrefused')) {
    return `${message}\nNothing is listening on that host and port. Confirm the server is up and bound to a reachable interface (e.g. start vLLM with --host 0.0.0.0) and that the port is correct.`;
  }
  if (lower.includes('certificate') || lower.includes('self-signed') || lower.includes('self signed') || lower.includes('cert')) {
    return `${message}\nTLS certificate problem. For an internal or self-signed HTTPS endpoint, either use an http:// URL or install the server's CA certificate.`;
  }
  if (lower.includes('econnreset')) {
    return `${message}\nThe connection was reset. A proxy, TLS mismatch (http:// vs https://), or the server closing the socket early can cause this.`;
  }
  if (lower.includes('failed to fetch') || lower.includes('fetch failed')) {
    return `${message}\nIs your inference server running and reachable at the configured URL?`;
  }
  return message;
}
