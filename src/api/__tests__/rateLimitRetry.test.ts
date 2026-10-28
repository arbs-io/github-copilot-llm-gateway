import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ChatHttpError } from '../client';
import {
  BASE_RETRY_DELAY_MS,
  DEFAULT_RATE_LIMIT_RETRIES,
  MAX_RATE_LIMIT_RETRIES,
  MAX_RETRY_DELAY_MS,
  normalizeRateLimitRetries,
  rateLimitRetryDelay,
  waitForRetry,
} from '../rateLimitRetry';

const noJitter = (): number => 0;

function httpError(status: number, retryAfterMs?: number): ChatHttpError {
  return new ChatHttpError(`Chat completion failed: ${status}`, status, '', retryAfterMs);
}

describe('rateLimitRetryDelay (issue #138)', () => {
  test('backs off exponentially from the base delay when no Retry-After is sent', () => {
    const error = httpError(429);
    assert.equal(rateLimitRetryDelay(error, 1, noJitter), BASE_RETRY_DELAY_MS);
    assert.equal(rateLimitRetryDelay(error, 2, noJitter), BASE_RETRY_DELAY_MS * 2);
    assert.equal(rateLimitRetryDelay(error, 3, noJitter), BASE_RETRY_DELAY_MS * 4);
  });

  test('caps the exponential delay', () => {
    assert.equal(rateLimitRetryDelay(httpError(429), 20, noJitter), MAX_RETRY_DELAY_MS);
  });

  test('adds up to 20% jitter', () => {
    assert.equal(rateLimitRetryDelay(httpError(429), 1, () => 1), BASE_RETRY_DELAY_MS * 1.2);
  });

  test('retries 503 Service Unavailable too', () => {
    assert.equal(rateLimitRetryDelay(httpError(503), 1, noJitter), BASE_RETRY_DELAY_MS);
  });

  test('honours the server Retry-After exactly', () => {
    assert.equal(rateLimitRetryDelay(httpError(429, 7000), 1, () => 1), 7000);
    assert.equal(rateLimitRetryDelay(httpError(429, 0), 3), 0);
  });

  test('gives up when Retry-After exceeds the longest wait', () => {
    assert.equal(rateLimitRetryDelay(httpError(429, MAX_RETRY_DELAY_MS + 1), 1), undefined);
  });

  test('does not retry other statuses or non-HTTP errors', () => {
    assert.equal(rateLimitRetryDelay(httpError(400), 1), undefined);
    assert.equal(rateLimitRetryDelay(httpError(500), 1), undefined);
    assert.equal(rateLimitRetryDelay(new Error('429 Too Many Requests'), 1), undefined);
    assert.equal(rateLimitRetryDelay('429', 1), undefined);
  });
});

describe('normalizeRateLimitRetries', () => {
  test('keeps whole numbers in range', () => {
    assert.equal(normalizeRateLimitRetries(0), 0);
    assert.equal(normalizeRateLimitRetries(5), 5);
  });

  test('clamps and floors out-of-range values', () => {
    assert.equal(normalizeRateLimitRetries(-1), 0);
    assert.equal(normalizeRateLimitRetries(99), MAX_RATE_LIMIT_RETRIES);
    assert.equal(normalizeRateLimitRetries(2.7), 2);
  });

  test('falls back to the default for non-numbers', () => {
    assert.equal(normalizeRateLimitRetries('3'), DEFAULT_RATE_LIMIT_RETRIES);
    assert.equal(normalizeRateLimitRetries(Number.NaN), DEFAULT_RATE_LIMIT_RETRIES);
    assert.equal(normalizeRateLimitRetries(undefined), DEFAULT_RATE_LIMIT_RETRIES);
  });
});

describe('waitForRetry', () => {
  function cancellableToken(): {
    token: Parameters<typeof waitForRetry>[1];
    cancel: () => void;
    listenerCount: () => number;
  } {
    let cancelled = false;
    const listeners = new Set<() => void>();
    return {
      token: {
        get isCancellationRequested() { return cancelled; },
        onCancellationRequested(listener: () => void) {
          listeners.add(listener);
          return { dispose: () => listeners.delete(listener) };
        },
      },
      cancel: () => {
        cancelled = true;
        for (const listener of [...listeners]) { listener(); }
      },
      listenerCount: () => listeners.size,
    };
  }

  test('resolves true after the delay and releases the listener', async () => {
    const { token, listenerCount } = cancellableToken();
    assert.equal(await waitForRetry(5, token), true);
    assert.equal(listenerCount(), 0);
  });

  test('resolves false as soon as the request is cancelled', async () => {
    const { token, cancel, listenerCount } = cancellableToken();
    const started = Date.now();
    const wait = waitForRetry(60000, token);
    cancel();
    assert.equal(await wait, false);
    assert.ok(Date.now() - started < 1000);
    assert.equal(listenerCount(), 0);
  });

  test('resolves false immediately when already cancelled', async () => {
    const { token, cancel } = cancellableToken();
    cancel();
    assert.equal(await waitForRetry(60000, token), false);
  });
});
