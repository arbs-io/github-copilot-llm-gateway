import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeBaseUrl, normalizeApiKey } from '../client';

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
