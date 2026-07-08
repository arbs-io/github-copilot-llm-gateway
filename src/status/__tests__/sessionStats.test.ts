import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  SessionStats,
  accumulateUsage,
  averageTokensPerRequest,
  emptySessionStats,
  formatRelativeTime,
  recordRequest,
} from '../sessionStats';

function fromState(partial: Partial<SessionStats>): SessionStats {
  return { ...emptySessionStats(), ...partial };
}

describe('emptySessionStats', () => {
  test('starts at zero across every counter', () => {
    assert.deepEqual(emptySessionStats(), {
      requestCount: 0,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      requestsWithUsage: 0,
    });
  });
});

describe('recordRequest', () => {
  test('increments requestCount but leaves token counters alone', () => {
    const next = recordRequest(emptySessionStats());
    assert.equal(next.requestCount, 1);
    assert.equal(next.promptTokens, 0);
    assert.equal(next.completionTokens, 0);
    assert.equal(next.requestsWithUsage, 0);
  });

  test('does not mutate the input', () => {
    const initial = emptySessionStats();
    const after = recordRequest(initial);
    assert.equal(initial.requestCount, 0);
    assert.notEqual(after, initial);
  });
});

describe('accumulateUsage', () => {
  test('sums prompt/completion/total across calls', () => {
    let stats = emptySessionStats();
    stats = accumulateUsage(stats, { prompt: 100, completion: 200, total: 300 });
    stats = accumulateUsage(stats, { prompt: 50, completion: 75, total: 125 });
    assert.equal(stats.promptTokens, 150);
    assert.equal(stats.completionTokens, 275);
    assert.equal(stats.totalTokens, 425);
    assert.equal(stats.requestsWithUsage, 2);
  });

  test('treats negative values as zero so a bad server cannot corrupt totals', () => {
    const stats = accumulateUsage(emptySessionStats(), {
      prompt: -50,
      completion: 100,
      total: 50,
    });
    assert.equal(stats.promptTokens, 0);
    assert.equal(stats.completionTokens, 100);
    assert.equal(stats.totalTokens, 50);
  });

  test('treats NaN / Infinity as zero', () => {
    const stats = accumulateUsage(emptySessionStats(), {
      prompt: Number.NaN,
      completion: Number.POSITIVE_INFINITY,
      total: 10,
    });
    assert.equal(stats.promptTokens, 0);
    assert.equal(stats.completionTokens, 0);
    assert.equal(stats.totalTokens, 10);
  });

  test('floors fractional usage values', () => {
    const stats = accumulateUsage(emptySessionStats(), {
      prompt: 12.7,
      completion: 5.3,
      total: 18,
    });
    assert.equal(stats.promptTokens, 12);
    assert.equal(stats.completionTokens, 5);
  });
});

describe('averageTokensPerRequest', () => {
  test('returns 0 when no requests have reported usage', () => {
    assert.equal(averageTokensPerRequest(emptySessionStats()), 0);
    assert.equal(
      averageTokensPerRequest(fromState({ requestCount: 5, requestsWithUsage: 0 })),
      0
    );
  });

  test('divides totalTokens by requestsWithUsage, rounded', () => {
    const stats = fromState({
      totalTokens: 12_345,
      requestsWithUsage: 7,
    });
    assert.equal(averageTokensPerRequest(stats), Math.round(12_345 / 7));
  });
});

describe('formatRelativeTime', () => {
  const NOW = 10_000_000;

  test('returns "just now" within the first 5 seconds', () => {
    assert.equal(formatRelativeTime(NOW - 0, NOW), 'just now');
    assert.equal(formatRelativeTime(NOW - 4_000, NOW), 'just now');
  });

  test('uses seconds up to 59s', () => {
    assert.equal(formatRelativeTime(NOW - 5_000, NOW), '5s ago');
    assert.equal(formatRelativeTime(NOW - 59_000, NOW), '59s ago');
  });

  test('uses minutes from 1m to 59m', () => {
    assert.equal(formatRelativeTime(NOW - 60_000, NOW), '1m ago');
    assert.equal(formatRelativeTime(NOW - 59 * 60_000, NOW), '59m ago');
  });

  test('uses hours from 1h to 23h', () => {
    assert.equal(formatRelativeTime(NOW - 60 * 60_000, NOW), '1h ago');
    assert.equal(formatRelativeTime(NOW - 23 * 60 * 60_000, NOW), '23h ago');
  });

  test('uses days from 1d onwards', () => {
    assert.equal(formatRelativeTime(NOW - 24 * 60 * 60_000, NOW), '1d ago');
    assert.equal(formatRelativeTime(NOW - 10 * 24 * 60 * 60_000, NOW), '10d ago');
  });

  test('clamps future timestamps to "just now" rather than going negative', () => {
    assert.equal(formatRelativeTime(NOW + 50_000, NOW), 'just now');
  });
});
