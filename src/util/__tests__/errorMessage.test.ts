import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorMessage } from '../errorMessage';

test('errorMessage returns the message of an Error', () => {
  assert.equal(errorMessage(new TypeError('boom')), 'boom');
});

test('errorMessage stringifies non-Error throwables', () => {
  assert.equal(errorMessage('plain'), 'plain');
  assert.equal(errorMessage(42), '42');
  assert.equal(errorMessage(undefined), 'undefined');
});
