/**
 * Running session totals shown in the status dialog. Pure module so the
 * arithmetic can be unit-tested without the provider lifecycle. "Session"
 * here means "since the extension activated" — there is no persistence,
 * because the dialog is meant for at-a-glance current usage, not historical
 * billing.
 */

export interface TokenUsage {
  readonly prompt: number;
  readonly completion: number;
  readonly total: number;
}

export interface SessionStats {
  readonly requestCount: number;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
  /**
   * Number of requests that reported a usage frame. Used to display an
   * average tokens/request that ignores requests where the server gave us no
   * numbers (which would otherwise drag the average toward zero).
   */
  readonly requestsWithUsage: number;
}

export function emptySessionStats(): SessionStats {
  return {
    requestCount: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    requestsWithUsage: 0,
  };
}

/**
 * Increment the request counter. Always called once per completed request,
 * regardless of whether the server returned a usage frame.
 */
export function recordRequest(stats: SessionStats): SessionStats {
  return { ...stats, requestCount: stats.requestCount + 1 };
}

/**
 * Fold a usage frame into the totals. Negative or non-finite numbers are
 * coerced to zero so a misbehaving server can't poison the running totals.
 */
export function accumulateUsage(stats: SessionStats, usage: TokenUsage): SessionStats {
  const prompt = sanitize(usage.prompt);
  const completion = sanitize(usage.completion);
  const total = sanitize(usage.total);
  return {
    requestCount: stats.requestCount,
    promptTokens: stats.promptTokens + prompt,
    completionTokens: stats.completionTokens + completion,
    totalTokens: stats.totalTokens + total,
    requestsWithUsage: stats.requestsWithUsage + 1,
  };
}

function sanitize(n: number): number {
  if (!Number.isFinite(n) || n < 0) {
    return 0;
  }
  return Math.floor(n);
}

/** Average tokens per request that actually reported usage, or 0 when none did. */
export function averageTokensPerRequest(stats: SessionStats): number {
  if (stats.requestsWithUsage === 0) {
    return 0;
  }
  return Math.round(stats.totalTokens / stats.requestsWithUsage);
}

/**
 * Format a timestamp relative to `now` ("34s ago", "2m ago", "1h ago"). Used
 * for "Last refresh" and "Last request" rows in the status dialog. Values
 * within ~5 seconds collapse to "just now" so the row isn't constantly
 * counting up second by second.
 */
export function formatRelativeTime(timestamp: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - timestamp) / 1000));
  if (seconds < 5) {
    return 'just now';
  }
  if (seconds < 60) {
    return `${seconds}s ago`;
  }
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
