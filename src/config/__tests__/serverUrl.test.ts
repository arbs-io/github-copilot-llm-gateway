import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { validateServerUrl } from '../serverUrl';

describe('validateServerUrl', () => {
  test('normalizes supported HTTP origins and preserves proxy paths', () => {
    assert.deepEqual(validateServerUrl(' https://gateway.example/v1/ '), {
      ok: true,
      value: 'https://gateway.example/v1',
    });
    assert.deepEqual(validateServerUrl('https://gateway.example////'), {
      ok: true,
      value: 'https://gateway.example',
    });
  });

  test('rejects unsupported protocols and embedded credentials', () => {
    assert.equal(validateServerUrl('file:///tmp/gateway').ok, false);
    assert.equal(validateServerUrl('https://user:secret@gateway.example').ok, false);
  });

  test('rejects query strings and fragments', () => {
    assert.equal(validateServerUrl('https://gateway.example?token=secret').ok, false);
    assert.equal(validateServerUrl('https://gateway.example#fragment').ok, false);
  });
});
