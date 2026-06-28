import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseModelFetchError } from '../errorDiagnostics';
import { describeFetchError } from '../client';

describe('diagnoseModelFetchError', () => {
  test('adds a reachability hint for ECONNREFUSED', () => {
    const result = diagnoseModelFetchError('fetch failed: connect ECONNREFUSED 127.0.0.1:8000');
    assert.ok(result.toLowerCase().includes('listening'));
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

  test('adds a DNS hint for ENOTFOUND', () => {
    const result = diagnoseModelFetchError(
      'Failed to connect to inference server at http://my-host:42069: fetch failed: getaddrinfo ENOTFOUND my-host'
    );
    assert.ok(result.toLowerCase().includes('dns'));
    assert.ok(result.toLowerCase().includes('dev container'));
  });

  test('adds a routing/timeout hint for ETIMEDOUT', () => {
    const result = diagnoseModelFetchError('fetch failed: connect ETIMEDOUT 10.0.0.5:42069');
    assert.ok(result.toLowerCase().includes('timeout') || result.toLowerCase().includes('unreachable'));
    assert.ok(result.toLowerCase().includes('firewall'));
  });

  test('adds a bind-interface hint for ECONNREFUSED', () => {
    const result = diagnoseModelFetchError('fetch failed: connect ECONNREFUSED 127.0.0.1:8000');
    assert.ok(result.includes('0.0.0.0'));
  });

  test('adds a TLS hint for certificate errors', () => {
    const result = diagnoseModelFetchError('fetch failed: self-signed certificate in certificate chain');
    assert.ok(result.toLowerCase().includes('tls') || result.toLowerCase().includes('certificate'));
  });

  test('returns the input unchanged when no heuristic matches', () => {
    const result = diagnoseModelFetchError('weird unrecognised error');
    assert.equal(result, 'weird unrecognised error');
  });
});

describe('describeFetchError', () => {
  test('appends the undici cause to an opaque "fetch failed"', () => {
    const err = new TypeError('fetch failed');
    (err as { cause?: unknown }).cause = new Error('getaddrinfo ENOTFOUND lu-prd-ct-vllm-01');
    assert.equal(
      describeFetchError(err),
      'fetch failed: getaddrinfo ENOTFOUND lu-prd-ct-vllm-01'
    );
  });

  test('does not duplicate the cause when already in the message', () => {
    const err = new Error('boom ENOTFOUND host');
    (err as { cause?: unknown }).cause = new Error('ENOTFOUND host');
    assert.equal(describeFetchError(err), 'boom ENOTFOUND host');
  });

  test('returns the message unchanged when there is no cause', () => {
    assert.equal(describeFetchError(new Error('plain error')), 'plain error');
  });

  test('stringifies non-Error inputs', () => {
    assert.equal(describeFetchError('just a string'), 'just a string');
  });
});
