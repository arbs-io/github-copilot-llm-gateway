import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaseUrl, normalizeApiKey, buildHeaders } from '../client';

describe('normalizeBaseUrl', () => {
  test('returns the URL unchanged when no normalization is needed', () => {
    assert.equal(normalizeBaseUrl('http://localhost:8000'), 'http://localhost:8000');
  });

  test('strips trailing slashes', () => {
    assert.equal(normalizeBaseUrl('http://localhost:8000/'), 'http://localhost:8000');
    assert.equal(normalizeBaseUrl('http://localhost:8000///'), 'http://localhost:8000');
  });

  test('strips a trailing /v1 (the most common user mistake)', () => {
    assert.equal(normalizeBaseUrl('http://localhost:8000/v1'), 'http://localhost:8000');
    assert.equal(normalizeBaseUrl('http://localhost:8000/v1/'), 'http://localhost:8000');
  });

  test('strips a trailing /openai/v1 (Azure-style endpoints)', () => {
    assert.equal(normalizeBaseUrl('https://x/openai/v1'), 'https://x');
    assert.equal(normalizeBaseUrl('https://x/openai/v1/'), 'https://x');
  });

  test('preserves other path segments', () => {
    assert.equal(normalizeBaseUrl('http://host/proxy'), 'http://host/proxy');
  });

  test('trims surrounding whitespace', () => {
    assert.equal(normalizeBaseUrl('  http://localhost:8000  '), 'http://localhost:8000');
  });
});

describe('normalizeApiKey', () => {
  test('returns empty string for undefined / empty input', () => {
    assert.equal(normalizeApiKey(undefined), '');
    assert.equal(normalizeApiKey(''), '');
    assert.equal(normalizeApiKey('   '), '');
  });

  test('returns the key unchanged when no Bearer prefix', () => {
    assert.equal(normalizeApiKey('sk-abc'), 'sk-abc');
  });

  test('strips a leading "Bearer " prefix', () => {
    assert.equal(normalizeApiKey('Bearer sk-abc'), 'sk-abc');
    assert.equal(normalizeApiKey('bearer sk-abc'), 'sk-abc');
    assert.equal(normalizeApiKey('BEARER  sk-abc'), 'sk-abc');
  });

  test('trims surrounding whitespace before stripping', () => {
    assert.equal(normalizeApiKey('   Bearer sk-abc   '), 'sk-abc');
  });
});

describe('buildHeaders', () => {
  test('returns empty headers when no apiKey or customHeaders are set', () => {
    assert.deepEqual(buildHeaders(undefined, undefined), {});
    assert.deepEqual(buildHeaders('', {}), {});
  });

  test('sets Bearer Authorization from a normalized apiKey', () => {
    assert.deepEqual(buildHeaders('sk-abc', undefined), { Authorization: 'Bearer sk-abc' });
    assert.deepEqual(buildHeaders('Bearer sk-abc', undefined), { Authorization: 'Bearer sk-abc' });
  });

  test('merges customHeaders alongside Authorization', () => {
    const headers = buildHeaders('sk-abc', {
      'Anthropic-Version': '2024-01-01',
      'OpenAI-Organization': 'org_xyz',
    });
    assert.equal(headers['Authorization'], 'Bearer sk-abc');
    assert.equal(headers['Anthropic-Version'], '2024-01-01');
    assert.equal(headers['OpenAI-Organization'], 'org_xyz');
  });

  test('customHeaders can override Authorization for non-Bearer auth schemes', () => {
    const headers = buildHeaders('sk-abc', { Authorization: 'Token raw-token' });
    assert.equal(headers['Authorization'], 'Token raw-token');
  });

  test('drops headers with non-string values or empty names', () => {
    const headers = buildHeaders(undefined, {
      Valid: 'yes',
      '': 'no-name',
      // Simulate a JSON-loaded value that wasn't a string.
      Bogus: 42 as unknown as string,
    });
    assert.equal(headers['Valid'], 'yes');
    assert.equal(headers[''], undefined);
    assert.equal(headers['Bogus'], undefined);
  });
});
