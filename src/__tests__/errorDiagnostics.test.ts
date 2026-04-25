import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseModelFetchError } from '../errorDiagnostics';

describe('diagnoseModelFetchError', () => {
  test('adds a reachability hint for ECONNREFUSED', () => {
    const result = diagnoseModelFetchError('fetch failed: connect ECONNREFUSED 127.0.0.1:8000');
    assert.ok(result.includes('running and reachable'));
  });

  test('adds a /v1 hint for 404 errors', () => {
    const result = diagnoseModelFetchError(
      'Failed to fetch models from http://x/v1/models: 404 Not Found'
    );
    assert.ok(result.includes('/v1'));
    assert.ok(result.toLowerCase().includes('remove'));
  });

  test('adds a key hint for 401 errors', () => {
    const result = diagnoseModelFetchError('Server returned 401 Unauthorized');
    assert.ok(result.includes('Authentication'));
    assert.ok(result.includes('Bearer'));
  });

  test('adds a timeout hint for aborts', () => {
    const result = diagnoseModelFetchError('The operation was aborted');
    assert.ok(result.toLowerCase().includes('timeout'));
  });

  test('returns the input unchanged when no heuristic matches', () => {
    const result = diagnoseModelFetchError('weird unrecognised error');
    assert.equal(result, 'weird unrecognised error');
  });
});
