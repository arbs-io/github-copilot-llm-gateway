/**
 * Backoff policy for chat requests the server rejected as rate limited or
 * temporarily unavailable (issue #138). Kept free of the `vscode` runtime so
 * the delay schedule is unit-testable.
 */
import { ChatHttpError } from './client';

/** 429 Too Many Requests and 503 Service Unavailable are worth retrying. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([429, 503]);
/** Default for the `rateLimitRetries` setting. */
export const DEFAULT_RATE_LIMIT_RETRIES = 3;
/** Upper bound for the `rateLimitRetries` setting. */
export const MAX_RATE_LIMIT_RETRIES = 10;
/** First backoff delay when the server sends no `Retry-After`; doubles per retry. */
export const BASE_RETRY_DELAY_MS = 2000;
/**
 * Longest single wait. Exponential delays are capped here; a `Retry-After`
 * longer than this is not waited out, since the chat would sit silent for
 * minutes — the error is shown instead so the user can decide.
 */
export const MAX_RETRY_DELAY_MS = 60000;
/** Random extra of up to this fraction of the delay, so parallel requests don't retry in lockstep. */
const JITTER_FRACTION = 0.2;

/**
 * How long to wait before retry number `retry` (1-based) of a failed chat
 * request, or `undefined` when the error is not a retryable HTTP status or
 * the server asked for a longer wait than `MAX_RETRY_DELAY_MS`.
 */
export function rateLimitRetryDelay(
  error: unknown,
  retry: number,
  random: () => number = Math.random
): number | undefined {
  if (!(error instanceof ChatHttpError) || !RETRYABLE_STATUSES.has(error.status)) {
    return undefined;
  }
  if (error.retryAfterMs !== undefined) {
    return error.retryAfterMs <= MAX_RETRY_DELAY_MS ? error.retryAfterMs : undefined;
  }
  const exponential = Math.min(BASE_RETRY_DELAY_MS * 2 ** (retry - 1), MAX_RETRY_DELAY_MS);
  return Math.round(exponential * (1 + JITTER_FRACTION * random()));
}

/** Clamp a raw `rateLimitRetries` setting value to a whole number in [0, MAX]. */
export function normalizeRateLimitRetries(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_RATE_LIMIT_RETRIES;
  }
  return Math.min(MAX_RATE_LIMIT_RETRIES, Math.max(0, Math.floor(value)));
}

/** The subset of `vscode.CancellationToken` the wait needs. */
interface CancellationLike {
  readonly isCancellationRequested: boolean;
  onCancellationRequested(listener: () => void): { dispose(): void };
}

/**
 * Wait `ms`, resolving early if the request is cancelled. Resolves `true`
 * when the full delay elapsed, `false` when cancelled.
 */
export function waitForRetry(ms: number, token: CancellationLike): Promise<boolean> {
  if (token.isCancellationRequested) {
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const subscription = token.onCancellationRequested(() => {
      clearTimeout(timer);
      subscription.dispose();
      resolve(false);
    });
    const timer = setTimeout(() => {
      subscription.dispose();
      resolve(true);
    }, ms);
  });
}
