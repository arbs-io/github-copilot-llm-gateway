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

  test('extraOptions cannot override protected base fields', () => {
    const req = buildChatRequest({
      model: 'm',
      messages: [{ role: 'user', content: 'safe' }],
      maxTokens: 10,
      temperature: 0.5,
      tools: [{ type: 'function', function: { name: 'safe_tool' } }],
      toolChoice: 'auto',
      parallelToolCalls: false,
      extraOptions: {
        model: 'replacement',
        messages: [],
        max_tokens: 999,
        temperature: 0.9,
        tools: [],
        tool_choice: 'required',
        parallel_tool_calls: true,
        stream: false,
        stream_options: { include_usage: false },
      },
    });
    assert.equal(req.model, 'm');
    assert.deepEqual(req.messages, [{ role: 'user', content: 'safe' }]);
    assert.equal(req.max_tokens, 10);
    assert.equal(req.temperature, 0.5);
    assert.equal(req.tools?.[0].function.name, 'safe_tool');
    assert.equal(req.tool_choice, 'auto');
    assert.equal(req.parallel_tool_calls, false);
    assert.equal(req.stream, undefined);
    assert.equal(req.stream_options, undefined);
  });

  test('per-request modelOptions take precedence over user-configured extras', () => {
    // Mirrors how the provider merges them:
    //   extraOptions: { ...config.extraModelOptions, ...options.modelOptions }
    const userExtras = { top_k: 40, repetition_penalty: 1.1 };
    const perRequest = { top_k: 20 };
    const req = buildChatRequest({
      model: 'm',
      messages: [],
      maxTokens: 10,
      temperature: 0.5,
      extraOptions: { ...userExtras, ...perRequest },
    });
    assert.equal(req.top_k, 20);
    assert.equal(req.repetition_penalty, 1.1);
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

  test('strips extraOptions keys starting with underscore', () => {
    const req = buildChatRequest({
      model: 'm',
      messages: [],
      maxTokens: 10,
      temperature: 0.5,
      extraOptions: {
        top_p: 0.9,
        _otelTraceContext: 'some-trace-id',
        _telemetryTurn: 'some-turn-id',
        _capturingTokenCorrelationId: 'some-correlation-id',
      },
    });
    assert.equal(req.top_p, 0.9);
    assert.equal(req._otelTraceContext, undefined);
    assert.equal(req._telemetryTurn, undefined);
    assert.equal(req._capturingTokenCorrelationId, undefined);
  });

  test('drops prototype-pollution keys from extraOptions', () => {
    const extraOptions = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":{"polluted":true},"prototype":{"polluted":true}}'
    ) as Record<string, unknown>;
    const req = buildChatRequest({
      model: 'm',
      messages: [],
      maxTokens: 10,
      temperature: 0.5,
      extraOptions,
    });

    assert.equal(Object.prototype.hasOwnProperty.call(req, '__proto__'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(req, 'constructor'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(req, 'prototype'), false);
    assert.equal(({} as { polluted?: boolean }).polluted, undefined);
  });

  test('drops serialization hooks and unsafe nested objects from extraOptions', () => {
    const req = buildChatRequest({
      model: 'safe-model',
      messages: [{ role: 'user', content: 'safe' }],
      maxTokens: 10,
      temperature: 0.5,
      extraOptions: {
        toJSON: () => ({ model: 'attacker-model' }),
        nested: {
          toJSON: () => ({ messages: [] }),
        },
        safe: { top_k: 20 },
      },
    });

    assert.equal(Object.prototype.hasOwnProperty.call(req, 'toJSON'), false);
    assert.equal(req.nested, undefined);
    assert.deepEqual(req.safe, { top_k: 20 });
    assert.equal(JSON.parse(JSON.stringify(req)).model, 'safe-model');
  });

  test('does not invoke accessors while copying request extras', () => {
    let invoked = false;
    const extraOptions: Record<string, unknown> = { safe: 1 };
    Object.defineProperty(extraOptions, 'temperature_override', {
      enumerable: true,
      get: () => {
        invoked = true;
        return 999;
      },
    });
    const req = buildChatRequest({
      model: 'm',
      messages: [],
      maxTokens: 10,
      temperature: 0.5,
      extraOptions,
    });

    assert.equal(invoked, false);
    assert.equal(req.safe, undefined);
    assert.equal(req.temperature_override, undefined);
  });
});
