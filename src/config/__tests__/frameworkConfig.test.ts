import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFrameworkConfiguration, resolveApiKey } from '../frameworkConfig';

describe('readFrameworkConfiguration', () => {
  test('returns an empty override when configuration is undefined', () => {
    assert.deepEqual(readFrameworkConfiguration(undefined), {});
  });

  test('returns an empty override when configuration is null', () => {
    assert.deepEqual(readFrameworkConfiguration(null), {});
  });

  test('returns an empty override when configuration is an empty object', () => {
    assert.deepEqual(readFrameworkConfiguration({}), {});
  });

  test('extracts a non-empty apiKey when present', () => {
    assert.deepEqual(readFrameworkConfiguration({ apiKey: 'sk-1234' }), {
      apiKey: 'sk-1234',
    });
  });

  test('preserves an explicit empty-string apiKey (user-cleared in native UI)', () => {
    assert.deepEqual(readFrameworkConfiguration({ apiKey: '' }), { apiKey: '' });
  });

  test('ignores apiKey when it is not a string', () => {
    assert.deepEqual(readFrameworkConfiguration({ apiKey: 42 }), {});
    assert.deepEqual(readFrameworkConfiguration({ apiKey: null }), {});
    assert.deepEqual(readFrameworkConfiguration({ apiKey: true }), {});
    assert.deepEqual(readFrameworkConfiguration({ apiKey: { nested: 'x' } }), {});
  });

  test('does not extract serverUrl (kept in workspace settings for issue #23)', () => {
    assert.deepEqual(
      readFrameworkConfiguration({ apiKey: 'k', serverUrl: 'http://x' }),
      { apiKey: 'k' }
    );
  });

  test('ignores unrelated keys', () => {
    assert.deepEqual(
      readFrameworkConfiguration({ unknown: 'foo', extra: 123 }),
      {}
    );
  });
});

describe('resolveApiKey', () => {
  test('returns the framework override when set to a non-empty string', () => {
    assert.equal(resolveApiKey({ apiKey: 'sk-framework' }, 'sk-secret'), 'sk-framework');
  });

  test('returns the framework override when explicitly cleared to empty string', () => {
    // The user pressing "clear" in the native UI should override any stale
    // SecretStorage entry, otherwise we'd silently re-authenticate with an
    // old credential.
    assert.equal(resolveApiKey({ apiKey: '' }, 'sk-secret'), '');
  });

  test('falls back to the SecretStorage cache when override is unset', () => {
    assert.equal(resolveApiKey({}, 'sk-secret'), 'sk-secret');
  });

  test('returns empty string when both override and cache are unset', () => {
    assert.equal(resolveApiKey({}, ''), '');
  });

  test('framework override of empty string still wins over a non-empty cache', () => {
    assert.equal(resolveApiKey({ apiKey: '' }, 'leftover-secret'), '');
  });
});
