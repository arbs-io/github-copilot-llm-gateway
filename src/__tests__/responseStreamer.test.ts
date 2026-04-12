import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  StreamChunk,
  StreamReporter,
  isEmptyStreamResult,
  streamResponse,
} from '../responseStreamer';

interface ReporterEvent {
  kind: 'text' | 'thinking' | 'thinkingDone' | 'toolCall';
  value?: string;
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

function makeReporter(): { reporter: StreamReporter; events: ReporterEvent[] } {
  const events: ReporterEvent[] = [];
  const reporter: StreamReporter = {
    reportText: (text) => events.push({ kind: 'text', value: text }),
    reportThinking: (text) => events.push({ kind: 'thinking', value: text }),
    reportThinkingDone: () => events.push({ kind: 'thinkingDone' }),
    reportToolCall: (id, name, args) => events.push({ kind: 'toolCall', id, name, args }),
  };
  return { reporter, events };
}

async function* iter(chunks: StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) {
    yield chunk;
  }
}

const identityArgs = (tc: { arguments: string }): Record<string, unknown> => {
  try {
    return JSON.parse(tc.arguments) as Record<string, unknown>;
  } catch {
    return {};
  }
};

describe('streamResponse', () => {
  test('reports plain text content', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([{ content: 'hello' }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.totalTextParts, 1);
    assert.equal(stats.totalContent, 'hello');
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'text');
    assert.equal(events[0].value, 'hello');
  });

  test('reports reasoning_content as thinking and closes it when text starts', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([
        { reasoning_content: 'I should think' },
        { content: 'then say this' },
      ]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.hadThinking, true);
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ['thinking', 'thinkingDone', 'text']);
    assert.equal(events[0].value, 'I should think');
  });

  test('closes a trailing reasoning_content block at end-of-stream', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([{ reasoning_content: 'only reasoning' }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.hadThinking, true);
    const kinds = events.map((e) => e.kind);
    assert.deepEqual(kinds, ['thinking', 'thinkingDone']);
  });

  test('parses inline <thinking> tags in content', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([
        { content: 'prefix <thinking>hidden</thinking> visible' },
      ]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.hadThinking, true);
    const textEvents = events.filter((e) => e.kind === 'text').map((e) => e.value);
    const thinkingEvents = events.filter((e) => e.kind === 'thinking').map((e) => e.value);
    assert.deepEqual(thinkingEvents, ['hidden']);
    // Concatenated visible text should match.
    assert.equal(textEvents.join(''), 'prefix  visible');
    assert.ok(events.some((e) => e.kind === 'thinkingDone'));
  });

  test('handles <thinking> tag split across chunks', async () => {
    const { reporter, events } = makeReporter();
    await streamResponse({
      chunks: iter([
        { content: 'pre<think' },
        { content: 'ing>mid</think' },
        { content: 'ing>post' },
      ]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    const textValue = events
      .filter((e) => e.kind === 'text')
      .map((e) => e.value)
      .join('');
    const thinkingValue = events
      .filter((e) => e.kind === 'thinking')
      .map((e) => e.value)
      .join('');
    assert.equal(textValue, 'prepost');
    assert.equal(thinkingValue, 'mid');
  });

  test('dispatches finished tool calls through resolveToolCallArgs', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([
        {
          finished_tool_calls: [
            { id: 'c1', name: 'search', arguments: '{"q":"hi"}' },
          ],
        },
      ]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: (tc) => JSON.parse(tc.arguments) as Record<string, unknown>,
    });
    assert.equal(stats.totalToolCalls, 1);
    assert.equal(events.length, 1);
    assert.equal(events[0].kind, 'toolCall');
    assert.equal(events[0].id, 'c1');
    assert.equal(events[0].name, 'search');
    assert.deepEqual(events[0].args, { q: 'hi' });
  });

  test('stops early when isCancelled returns true', async () => {
    const { reporter, events } = makeReporter();
    let callCount = 0;
    await streamResponse({
      chunks: iter([{ content: 'first' }, { content: 'second' }, { content: 'third' }]),
      reporter,
      isCancelled: () => {
        callCount++;
        // After two iterations, cancel.
        return callCount > 2;
      },
      resolveToolCallArgs: identityArgs,
    });
    const textEvents = events.filter((e) => e.kind === 'text');
    assert.ok(textEvents.length < 3);
  });

  test('emits fallback text when stream force-closes mid-thinking with no output', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      // Unclosed <thinking> tag — parser.flush() will emit an 'E' piece.
      chunks: iter([{ content: '<thinking>still thinking' }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.thinkingForceClosed, true);
    assert.equal(stats.totalTextParts, 0);
    assert.equal(stats.totalToolCalls, 0);
    // Fallback message should be reported as text.
    const fallback = events.find(
      (e) => e.kind === 'text' && e.value?.includes('ran out of output tokens')
    );
    assert.ok(fallback, 'expected fallback text to be emitted');
  });

  test('does not emit fallback when force-closed but text parts exist', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([{ content: 'visible <thinking>incomplete' }]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.thinkingForceClosed, true);
    assert.ok(stats.totalTextParts > 0);
    const fallback = events.find(
      (e) => e.kind === 'text' && e.value?.includes('ran out of output tokens')
    );
    assert.equal(fallback, undefined);
  });

  test('returns zeroed stats on an empty stream', async () => {
    const { reporter, events } = makeReporter();
    const stats = await streamResponse({
      chunks: iter([]),
      reporter,
      isCancelled: () => false,
      resolveToolCallArgs: identityArgs,
    });
    assert.equal(stats.totalContent, '');
    assert.equal(stats.totalTextParts, 0);
    assert.equal(stats.totalToolCalls, 0);
    assert.equal(stats.hadThinking, false);
    assert.equal(stats.thinkingForceClosed, false);
    assert.equal(events.length, 0);
  });
});

describe('isEmptyStreamResult', () => {
  test('true for zeroed stats', () => {
    assert.equal(
      isEmptyStreamResult({
        totalContent: '',
        totalTextParts: 0,
        totalToolCalls: 0,
        hadThinking: false,
        thinkingForceClosed: false,
      }),
      true
    );
  });

  test('false when there is content', () => {
    assert.equal(
      isEmptyStreamResult({
        totalContent: 'hi',
        totalTextParts: 1,
        totalToolCalls: 0,
        hadThinking: false,
        thinkingForceClosed: false,
      }),
      false
    );
  });

  test('false when there are tool calls', () => {
    assert.equal(
      isEmptyStreamResult({
        totalContent: '',
        totalTextParts: 0,
        totalToolCalls: 1,
        hadThinking: false,
        thinkingForceClosed: false,
      }),
      false
    );
  });

  test('false when thinking occurred', () => {
    assert.equal(
      isEmptyStreamResult({
        totalContent: '',
        totalTextParts: 0,
        totalToolCalls: 0,
        hadThinking: true,
        thinkingForceClosed: false,
      }),
      false
    );
  });

  test('false when thinking was force-closed', () => {
    assert.equal(
      isEmptyStreamResult({
        totalContent: '',
        totalTextParts: 0,
        totalToolCalls: 0,
        hadThinking: false,
        thinkingForceClosed: true,
      }),
      false
    );
  });
});
