import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { isSecretOriginAllowed } from '../secretOrigin';

describe('isSecretOriginAllowed', () => {
  test('allows a secret only at its bound server origin', () => {
    assert.equal(
      isSecretOriginAllowed(
        'https://gateway.example',
        'https://gateway.example',
        true
      ),
      true
    );
    assert.equal(
      isSecretOriginAllowed(
        'https://gateway.example',
        'https://untrusted.example',
        true
      ),
      false
    );
  });

  test('withholds legacy unbound secrets from workspace URL overrides', () => {
    assert.equal(isSecretOriginAllowed(undefined, 'https://workspace.example', true), false);
    assert.equal(isSecretOriginAllowed(undefined, 'https://user.example', false), true);
  });
});
