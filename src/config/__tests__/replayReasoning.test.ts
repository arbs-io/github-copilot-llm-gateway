import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReplayReasoning } from '../replayReasoning';

function config(replayReasoning: boolean, replayReasoningModels: Record<string, unknown> = {}) {
  return { replayReasoning, replayReasoningModels: replayReasoningModels as Record<string, boolean> };
}

describe('resolveReplayReasoning', () => {
  test('falls back to the global switch when nothing matches', () => {
    assert.equal(resolveReplayReasoning('qwen3', config(false, { 'deepseek*': true })), false);
    assert.equal(resolveReplayReasoning('qwen3', config(true, { 'deepseek*': false })), true);
    assert.equal(resolveReplayReasoning('qwen3', config(true)), true);
  });

  test('a wildcard match overrides the global switch, case-insensitively', () => {
    assert.equal(resolveReplayReasoning('DeepSeek-V3', config(false, { 'deepseek*': true })), true);
  });

  test('a model entry of false disables replay when the global switch is on', () => {
    assert.equal(resolveReplayReasoning('gpt-4o', config(true, { 'gpt-*': false })), false);
  });

  test('an exact id beats a wildcard, whichever comes first', () => {
    const models = { 'deepseek-chat': false, 'deepseek*': true };
    assert.equal(resolveReplayReasoning('deepseek-chat', config(false, models)), false);
    assert.equal(resolveReplayReasoning('deepseek-reasoner', config(false, models)), true);
    const reversed = { 'deepseek*': true, 'deepseek-chat': false };
    assert.equal(resolveReplayReasoning('deepseek-chat', config(false, reversed)), false);
  });

  test('the last matching wildcard wins, as in modelContextWindows', () => {
    const models = { 'deepseek*': true, '*chat': false };
    assert.equal(resolveReplayReasoning('deepseek-chat', config(false, models)), false);
  });

  test('ignores non-boolean values', () => {
    const models = { 'deepseek-chat': 'true', 'deepseek*': 1 };
    assert.equal(resolveReplayReasoning('deepseek-chat', config(false, models)), false);
  });
});
