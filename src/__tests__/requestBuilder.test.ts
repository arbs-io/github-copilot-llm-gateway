import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { buildChatRequest } from '../requestBuilder';

describe('buildChatRequest', () => {
  test('builds a minimal request without tools', () => {
    const req = buildChatRequest({
      model: 'my-model',
      messages: [{ role: 'user', content: 'hi' }],
      maxTokens: 128,
      temperature: 0.7,
    });
    assert.equal(req.model, 'my-model');
    assert.equal(req.max_tokens, 128);
    assert.equal(req.temperature, 0.7);
    assert.deepEqual(req.messages, [{ role: 'user', content: 'hi' }]);
    assert.equal(req.tools, undefined);
    assert.equal(req.tool_choice, undefined);
    assert.equal(req.parallel_tool_calls, undefined);
  });

  test('omits tool fields when tools array is empty', () => {
    const req = buildChatRequest({
      model: 'm',
      messages: [],
      maxTokens: 1,
      temperature: 0,
      tools: [],
      toolChoice: 'auto',
      parallelToolCalls: true,
    });
    assert.equal(req.tools, undefined);
    assert.equal(req.tool_choice, undefined);
    assert.equal(req.parallel_tool_calls, undefined);
  });

  test('includes tools when non-empty', () => {
    const tools = [
      {
        type: 'function' as const,
        function: { name: 'search', description: 'search the web', parameters: {} },
      },
    ];
    const req = buildChatRequest({
      model: 'm',
      messages: [],
      maxTokens: 1,
      temperature: 0,
      tools,
      toolChoice: 'required',
      parallelToolCalls: false,
    });
    assert.deepEqual(req.tools, tools);
    assert.equal(req.tool_choice, 'required');
    assert.equal(req.parallel_tool_calls, false);
  });

  test('omits toolChoice when undefined even with tools', () => {
    const req = buildChatRequest({
      model: 'm',
      messages: [],
      maxTokens: 1,
      temperature: 0,
      tools: [{ type: 'function', function: { name: 'f' } }],
    });
    assert.equal(req.tool_choice, undefined);
    assert.equal(req.parallel_tool_calls, undefined);
  });

  test('merges extraOptions on top of base fields', () => {
    const req = buildChatRequest({
      model: 'm',
      messages: [],
      maxTokens: 10,
      temperature: 0.5,
      extraOptions: { top_p: 0.9, frequency_penalty: 0.1 },
    });
    assert.equal(req.top_p, 0.9);
    assert.equal(req.frequency_penalty, 0.1);
    assert.equal(req.max_tokens, 10);
  });

  test('extraOptions can override base fields', () => {
    const req = buildChatRequest({
      model: 'm',
      messages: [],
      maxTokens: 10,
      temperature: 0.5,
      extraOptions: { temperature: 0.9 },
    });
    assert.equal(req.temperature, 0.9);
  });

  test('handles `none` toolChoice', () => {
    const req = buildChatRequest({
      model: 'm',
      messages: [],
      maxTokens: 1,
      temperature: 0,
      tools: [{ type: 'function', function: { name: 'f' } }],
      toolChoice: 'none',
    });
    assert.equal(req.tool_choice, 'none');
  });
});
