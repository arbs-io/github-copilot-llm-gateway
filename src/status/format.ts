/**
 * Small pure formatting helpers shared by the status bar, tooltip, and
 * status snapshot: compact token counts and host extraction from server
 * URLs.
 */

/**
 * Format an integer token count into a short label suitable for the bar.
 *
 * The tiers (1.2k, 12k, 1.2M, 12M) trade precision for width so the responded
 * label fits in roughly the same space as the idle label.
 */
export function formatTokenCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    return '0';
  }
  if (n < 1000) {
    return String(Math.floor(n));
  }
  if (n < 10_000) {
    return `${(n / 1000).toFixed(1)}k`;
  }
  if (n < 1_000_000) {
    return `${Math.round(n / 1000)}k`;
  }
  if (n < 10_000_000) {
    return `${(n / 1_000_000).toFixed(1)}M`;
  }
  return `${Math.round(n / 1_000_000)}M`;
}

/**
 * Extract `host:port` from a server URL. Falls back to the raw string when the
 * URL is unparseable so a misconfigured server still shows something useful in
 * the bar rather than the literal word "invalid".
 */
export function extractHost(serverUrl: string): string {
  try {
    const parsed = new URL(serverUrl);
    return parsed.host || serverUrl;
  } catch {
    return serverUrl;
  }
}

/**
 * Drop the `:port` suffix from a `host:port` string so the status bar can
 * show just the hostname. The tooltip still gets the full `host:port` —
 * this is purely a compactness pass for the bar.
 *
 * Handles IPv6 literals (`[::1]:8000` → `[::1]`) by treating the bracket
 * as the end of the host portion. Falls through unchanged when no port
 * suffix is present.
 */
export function stripPort(hostPort: string): string {
  if (hostPort.startsWith('[')) {
    const close = hostPort.indexOf(']');
    return close > 0 ? hostPort.slice(0, close + 1) : hostPort;
  }
  const colon = hostPort.lastIndexOf(':');
  return colon >= 0 ? hostPort.slice(0, colon) : hostPort;
}
