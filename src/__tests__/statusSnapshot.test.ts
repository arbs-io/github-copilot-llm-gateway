import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { formatCapabilityLabels, formatContextLabel } from '../statusSnapshot';

describe('formatContextLabel', () => {
  test('formats a token count with the "ctx" suffix', () => {
    assert.equal(formatContextLabel(131_072), '131k ctx');
    assert.equal(formatContextLabel(8_192), '8.2k ctx');
    assert.equal(formatContextLabel(500), '500 ctx');
  });

  test('returns empty string for undefined / zero / negative', () => {
    assert.equal(formatContextLabel(undefined), '');
    assert.equal(formatContextLabel(0), '');
    assert.equal(formatContextLabel(-1), '');
  });
});

describe('formatCapabilityLabels', () => {
  test('returns tools and vision in stable order when both are set', () => {
    assert.deepEqual(formatCapabilityLabels({ toolCalling: true, imageInput: true }), [
      'tools',
      'vision',
    ]);
  });

  test('returns an empty array when nothing is enabled', () => {
    assert.deepEqual(formatCapabilityLabels({}), []);
    assert.deepEqual(formatCapabilityLabels({ toolCalling: false, imageInput: false }), []);
  });

  test('treats numeric toolCalling as enabled (matches LanguageModelChatCapabilities)', () => {
    assert.deepEqual(formatCapabilityLabels({ toolCalling: 16 }), ['tools']);
  });
});
