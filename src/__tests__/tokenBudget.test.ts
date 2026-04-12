import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  TOKEN_CONSTANTS,
  buildInputText,
  calculateMaxInputTokens,
  calculateSafeMaxOutputTokens,
  estimateMessageTokens,
  estimateTextTokens,
  truncateMessagesToFit,
} from '../tokenBudget';

describe('estimateTextTokens', () => {
  test('returns 0 for empty string', () => {
    assert.equal(estimateTextTokens(''), 0);
  });

  test('returns ceil(length / 4)', () => {
    assert.equal(estimateTextTokens('a'), 1);
    assert.equal(estimateTextTokens('abcd'), 1);
    assert.equal(estimateTextTokens('abcde'), 2);
    assert.equal(estimateTextTokens('a'.repeat(400)), 100);
  });
});

describe('estimateMessageTokens', () => {
  test('handles string content', () => {
    assert.equal(estimateMessageTokens({ content: 'hello world' }), Math.ceil('hello world'.length / 4));
  });

  test('handles array content', () => {
    const msg = { content: [{ type: 'text', text: 'hi' }] };
    const serialized = JSON.stringify(msg.content);
    assert.equal(estimateMessageTokens(msg), Math.ceil(serialized.length / 4));
  });

  test('adds tool_calls contribution', () => {
    const msg = { content: 'x', tool_calls: [{ id: '1', name: 'foo' }] };
    const expected = Math.ceil(('x' + JSON.stringify(msg.tool_calls)).length / 4);
    assert.equal(estimateMessageTokens(msg), expected);
  });

  test('handles empty message', () => {
    assert.equal(estimateMessageTokens({}), 0);
  });

  test('handles null content', () => {
    assert.equal(estimateMessageTokens({ content: null }), 0);
  });
});

describe('buildInputText', () => {
  test('joins string content with newlines', () => {
    const messages = [{ content: 'a' }, { content: 'b' }];
    assert.equal(buildInputText(messages), 'a\nb');
  });

  test('serializes array content', () => {
    const messages = [{ content: [{ type: 'text', text: 'x' }] }];
    assert.equal(buildInputText(messages), JSON.stringify(messages[0].content));
  });

  test('appends tool_calls to message text', () => {
    const messages = [{ content: 'hi', tool_calls: [{ id: '1' }] }];
    assert.equal(
      buildInputText(messages),
      'hi' + JSON.stringify(messages[0].tool_calls)
    );
  });

  test('returns empty string for empty message list', () => {
    assert.equal(buildInputText([]), '');
  });
});

describe('truncateMessagesToFit', () => {
  test('returns [] for empty input', () => {
    assert.deepEqual(truncateMessagesToFit([], 100), []);
  });

  test('returns all messages when under budget', () => {
    const messages = [{ content: 'a' }, { content: 'b' }];
    assert.deepEqual(truncateMessagesToFit(messages, 1000), messages);
  });

  test('always keeps first message even when over budget', () => {
    const messages = [
      { content: 'SYSTEM PROMPT' },
      { content: 'a'.repeat(100) },
      { content: 'b'.repeat(100) },
    ];
    const result = truncateMessagesToFit(messages, 40);
    assert.equal(result[0].content, 'SYSTEM PROMPT');
  });

  test('prefers recent messages over middle ones when truncating', () => {
    const messages = [
      { content: 'first' },
      { content: 'middle-older' },
      { content: 'middle-newer' },
      { content: 'last' },
    ];
    // estimateMessageTokens('first')=2, 'middle-older'=3, 'middle-newer'=3, 'last'=1
    // Budget 4 tokens: first(2) + last(1) = 3 ≤ 4; +middle-newer would be 6 > 4. Keep first+last.
    const result = truncateMessagesToFit(messages, 4);
    assert.deepEqual(
      result.map((m) => m.content),
      ['first', 'last']
    );
  });

  test('logs truncation events when provided a logger', () => {
    const messages = [
      { content: 'a'.repeat(40) },
      { content: 'b'.repeat(40) },
      { content: 'c'.repeat(40) },
    ];
    const logs: string[] = [];
    truncateMessagesToFit(messages, 5, (m) => logs.push(m));
    assert.ok(logs.some((m) => m.includes('Context overflow')));
    assert.ok(logs.some((m) => m.includes('Truncated')));
  });

  test('does not log when truncation is unnecessary', () => {
    const logs: string[] = [];
    truncateMessagesToFit([{ content: 'short' }], 100, (m) => logs.push(m));
    assert.equal(logs.length, 0);
  });
});

describe('calculateSafeMaxOutputTokens', () => {
  test('returns configured max when inputs are tiny', () => {
    const result = calculateSafeMaxOutputTokens({
      estimatedInputTokens: 10,
      toolsOverhead: 0,
      modelMaxContext: 32768,
      configuredMaxOutput: 2048,
    });
    assert.equal(result, 2048);
  });

  test('caps at remaining context when input is large', () => {
    const result = calculateSafeMaxOutputTokens({
      estimatedInputTokens: 30000,
      toolsOverhead: 0,
      modelMaxContext: 32768,
      configuredMaxOutput: 8192,
    });
    // 30000 * 1.2 = 36000, which is already > 32768 - 256 = 32512
    // So the calculation will go negative, and we hit the MIN_OUTPUT_TOKENS floor
    assert.equal(result, TOKEN_CONSTANTS.MIN_OUTPUT_TOKENS);
  });

  test('never returns less than MIN_OUTPUT_TOKENS', () => {
    const result = calculateSafeMaxOutputTokens({
      estimatedInputTokens: 100000,
      toolsOverhead: 5000,
      modelMaxContext: 4096,
      configuredMaxOutput: 1024,
    });
    assert.equal(result, TOKEN_CONSTANTS.MIN_OUTPUT_TOKENS);
  });

  test('includes tools overhead in the budget', () => {
    const withoutTools = calculateSafeMaxOutputTokens({
      estimatedInputTokens: 10000,
      toolsOverhead: 0,
      modelMaxContext: 16000,
      configuredMaxOutput: 4000,
    });
    const withTools = calculateSafeMaxOutputTokens({
      estimatedInputTokens: 10000,
      toolsOverhead: 2000,
      modelMaxContext: 16000,
      configuredMaxOutput: 4000,
    });
    assert.ok(withTools < withoutTools);
  });
});

describe('calculateMaxInputTokens', () => {
  test('reserves half the context for output when half is less than configured max', () => {
    const result = calculateMaxInputTokens({
      modelMaxContext: 10000,
      configuredMaxOutput: 8000,
      toolsSerializedLength: 0,
    });
    // desiredOutput = min(8000, 5000) = 5000
    // Expected = 10000 - 5000 - 0 - 256 = 4744
    assert.equal(result, 4744);
  });

  test('reserves configured output when less than half context', () => {
    const result = calculateMaxInputTokens({
      modelMaxContext: 32768,
      configuredMaxOutput: 2048,
      toolsSerializedLength: 0,
    });
    // desiredOutput = 2048; expected = 32768 - 2048 - 0 - 256 = 30464
    assert.equal(result, 30464);
  });

  test('subtracts tools overhead', () => {
    const baseline = calculateMaxInputTokens({
      modelMaxContext: 32768,
      configuredMaxOutput: 2048,
      toolsSerializedLength: 0,
    });
    const withTools = calculateMaxInputTokens({
      modelMaxContext: 32768,
      configuredMaxOutput: 2048,
      toolsSerializedLength: 4000,
    });
    assert.ok(withTools < baseline);
  });
});
