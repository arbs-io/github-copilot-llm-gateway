import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  ReplyTokenUsageTracker,
  extractReplyIdentity,
  extractToolResultIds,
  formatReplyTokenSummaryLine,
  ReplyIdentity,
} from '../replyTokenUsage';
import { OpenAIMessage } from '../../api/types';

const ID: ReplyIdentity = { conversationId: 'conv-1', turnIndex: 0 };

function known(prompt: number, completion: number) {
  return { promptTokens: prompt, completionTokens: completion, promptKnown: true, completionKnown: true };
}

describe('extractReplyIdentity', () => {
  test('accepts a nonempty conversationId and nonnegative safe integer turnIndex', () => {
    const identity = extractReplyIdentity({ _conversationId: 'abc', _telemetryTurn: 3 });
    assert.deepEqual(identity, { conversationId: 'abc', turnIndex: 3 });
  });

  test('rejects missing modelOptions', () => {
    assert.equal(extractReplyIdentity(undefined), undefined);
  });

  test('rejects an empty conversationId', () => {
    assert.equal(extractReplyIdentity({ _conversationId: '', _telemetryTurn: 0 }), undefined);
  });

  test('rejects a missing conversationId', () => {
    assert.equal(extractReplyIdentity({ _telemetryTurn: 0 }), undefined);
  });

  test('rejects a non-string conversationId', () => {
    assert.equal(extractReplyIdentity({ _conversationId: 42, _telemetryTurn: 0 }), undefined);
  });

  test('rejects a missing turnIndex', () => {
    assert.equal(extractReplyIdentity({ _conversationId: 'abc' }), undefined);
  });

  test('rejects a negative turnIndex', () => {
    assert.equal(extractReplyIdentity({ _conversationId: 'abc', _telemetryTurn: -1 }), undefined);
  });

  test('rejects a non-integer turnIndex', () => {
    assert.equal(extractReplyIdentity({ _conversationId: 'abc', _telemetryTurn: 1.5 }), undefined);
  });

  test('rejects an unsafe-integer turnIndex', () => {
    assert.equal(
      extractReplyIdentity({ _conversationId: 'abc', _telemetryTurn: Number.MAX_SAFE_INTEGER + 1 }),
      undefined
    );
  });
});

describe('extractToolResultIds', () => {
  test('collects tool_call_id from role:tool messages only', () => {
    const messages: OpenAIMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', tool_calls: [{ id: 'call_1' }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'result' },
      { role: 'tool', tool_call_id: 'call_2', content: 'result 2' },
    ];
    assert.deepEqual(extractToolResultIds(messages), ['call_1', 'call_2']);
  });

  test('ignores tool messages with a non-string tool_call_id', () => {
    const messages: OpenAIMessage[] = [{ role: 'tool', tool_call_id: 5, content: 'x' }];
    assert.deepEqual(extractToolResultIds(messages), []);
  });

  test('returns an empty array for no tool messages', () => {
    assert.deepEqual(extractToolResultIds([{ role: 'user', content: 'hi' }]), []);
  });
});

describe('ReplyTokenUsageTracker', () => {
  test('summarizes a plain single-round reply', () => {
    const tracker = new ReplyTokenUsageTracker();
    tracker.beginRound(ID, []);
    tracker.recordRound(ID, { usage: known(100, 10), outgoingToolCallIds: [] });
    assert.deepEqual(tracker.summarize(ID), {
      kind: 'complete', promptTokens: 100, completionTokens: 10, totalTokens: 110,
    });
  });

  test('accumulates usage across sequential tool-call rounds', () => {
    const tracker = new ReplyTokenUsageTracker();
    tracker.beginRound(ID, []);
    tracker.recordRound(ID, { usage: known(100, 10), outgoingToolCallIds: ['call_1'] });
    tracker.beginRound(ID, ['call_1']);
    tracker.recordRound(ID, { usage: known(200, 20), outgoingToolCallIds: ['call_2'] });
    tracker.beginRound(ID, ['call_2']);
    tracker.recordRound(ID, { usage: known(300, 30), outgoingToolCallIds: [] });
    assert.deepEqual(tracker.summarize(ID), {
      kind: 'complete', promptTokens: 600, completionTokens: 60, totalTokens: 660,
    });
  });

  test('counts a parallel tool-call batch once, not once per result', () => {
    const tracker = new ReplyTokenUsageTracker();
    tracker.beginRound(ID, []);
    tracker.recordRound(ID, { usage: known(100, 10), outgoingToolCallIds: ['call_1', 'call_2'] });
    // Both tool results answer the SAME preceding round.
    tracker.beginRound(ID, ['call_1', 'call_2']);
    tracker.recordRound(ID, { usage: known(150, 15), outgoingToolCallIds: [] });
    assert.deepEqual(tracker.summarize(ID), {
      kind: 'complete', promptTokens: 250, completionTokens: 25, totalTokens: 275,
    });
  });

  test('starts a fresh chain when incoming tool-result IDs do not match the pending round', () => {
    const tracker = new ReplyTokenUsageTracker();
    tracker.beginRound(ID, []);
    tracker.recordRound(ID, { usage: known(100, 10), outgoingToolCallIds: ['call_1'] });
    // Unrelated identity reuse (e.g. a stray/mismatched continuation) discards the prior partial chain.
    tracker.beginRound(ID, ['unrelated_call']);
    tracker.recordRound(ID, { usage: known(50, 5), outgoingToolCallIds: [] });
    assert.deepEqual(tracker.summarize(ID), {
      kind: 'complete', promptTokens: 50, completionTokens: 5, totalTokens: 55,
    });
  });

  test('isolates two concurrent chats with different conversation IDs', () => {
    const tracker = new ReplyTokenUsageTracker();
    const idA: ReplyIdentity = { conversationId: 'conv-a', turnIndex: 0 };
    const idB: ReplyIdentity = { conversationId: 'conv-b', turnIndex: 0 };
    tracker.beginRound(idA, []);
    tracker.recordRound(idA, { usage: known(10, 1), outgoingToolCallIds: [] });
    tracker.beginRound(idB, []);
    tracker.recordRound(idB, { usage: known(20, 2), outgoingToolCallIds: [] });
    assert.deepEqual(tracker.summarize(idA), { kind: 'complete', promptTokens: 10, completionTokens: 1, totalTokens: 11 });
    assert.deepEqual(tracker.summarize(idB), { kind: 'complete', promptTokens: 20, completionTokens: 2, totalTokens: 22 });
  });

  test('isolates a second reply (new turnIndex) after finish() clears the first', () => {
    const tracker = new ReplyTokenUsageTracker();
    tracker.beginRound(ID, []);
    tracker.recordRound(ID, { usage: known(10, 1), outgoingToolCallIds: [] });
    tracker.finish(ID);
    const nextTurn: ReplyIdentity = { conversationId: ID.conversationId, turnIndex: ID.turnIndex + 1 };
    tracker.beginRound(nextTurn, []);
    tracker.recordRound(nextTurn, { usage: known(30, 3), outgoingToolCallIds: [] });
    assert.deepEqual(tracker.summarize(nextTurn), { kind: 'complete', promptTokens: 30, completionTokens: 3, totalTokens: 33 });
    assert.deepEqual(tracker.summarize(ID), { kind: 'unavailable' });
  });

  test('marks the summary partial when one round is missing usage entirely', () => {
    const tracker = new ReplyTokenUsageTracker();
    tracker.beginRound(ID, []);
    tracker.recordRound(ID, { usage: known(100, 10), outgoingToolCallIds: ['call_1'] });
    tracker.beginRound(ID, ['call_1']);
    tracker.recordRound(ID, { usage: undefined, outgoingToolCallIds: [] });
    assert.deepEqual(tracker.summarize(ID), {
      kind: 'partial', promptTokens: 100, completionTokens: 10, totalTokens: 110,
    });
  });

  test('marks the summary partial when only one field of a round is known', () => {
    const tracker = new ReplyTokenUsageTracker();
    tracker.beginRound(ID, []);
    tracker.recordRound(ID, {
      usage: { promptTokens: 100, completionTokens: 0, promptKnown: true, completionKnown: false },
      outgoingToolCallIds: [],
    });
    assert.deepEqual(tracker.summarize(ID), {
      kind: 'partial', promptTokens: 100, completionTokens: 0, totalTokens: 100,
    });
  });

  test('reports unavailable when no round ever reported usage', () => {
    const tracker = new ReplyTokenUsageTracker();
    tracker.beginRound(ID, []);
    tracker.recordRound(ID, { usage: undefined, outgoingToolCallIds: [] });
    assert.deepEqual(tracker.summarize(ID), { kind: 'unavailable' });
  });

  test('reports unavailable for an identity that was never begun', () => {
    const tracker = new ReplyTokenUsageTracker();
    assert.deepEqual(tracker.summarize(ID), { kind: 'unavailable' });
  });

  test('recordRound is a no-op without a matching beginRound', () => {
    const tracker = new ReplyTokenUsageTracker();
    tracker.recordRound(ID, { usage: known(100, 10), outgoingToolCallIds: [] });
    assert.deepEqual(tracker.summarize(ID), { kind: 'unavailable' });
  });

  test('sanitizes negative and non-finite reported numbers to zero', () => {
    const tracker = new ReplyTokenUsageTracker();
    tracker.beginRound(ID, []);
    tracker.recordRound(ID, {
      usage: { promptTokens: -5, completionTokens: NaN, promptKnown: true, completionKnown: true },
      outgoingToolCallIds: [],
    });
    assert.deepEqual(tracker.summarize(ID), { kind: 'complete', promptTokens: 0, completionTokens: 0, totalTokens: 0 });
  });

  test('floors fractional reported numbers', () => {
    const tracker = new ReplyTokenUsageTracker();
    tracker.beginRound(ID, []);
    tracker.recordRound(ID, {
      usage: { promptTokens: 10.9, completionTokens: 5.1, promptKnown: true, completionKnown: true },
      outgoingToolCallIds: [],
    });
    assert.deepEqual(tracker.summarize(ID), { kind: 'complete', promptTokens: 10, completionTokens: 5, totalTokens: 15 });
  });

  test('evicts the oldest inactive chain once the bound is exceeded, keeping in-flight chains', () => {
    const tracker = new ReplyTokenUsageTracker(2);
    const idA: ReplyIdentity = { conversationId: 'a', turnIndex: 0 };
    const idB: ReplyIdentity = { conversationId: 'b', turnIndex: 0 };
    const idC: ReplyIdentity = { conversationId: 'c', turnIndex: 0 };
    // idA finishes a round (inFlight back to 0) and becomes the oldest evictable chain.
    tracker.beginRound(idA, []);
    tracker.recordRound(idA, { usage: known(1, 1), outgoingToolCallIds: [] });
    // idB stays in-flight (beginRound only, no recordRound yet).
    tracker.beginRound(idB, []);
    // idC pushes the tracker over its cap of 2.
    tracker.beginRound(idC, []);
    tracker.recordRound(idC, { usage: known(3, 3), outgoingToolCallIds: [] });

    assert.equal(tracker.size, 2);
    assert.deepEqual(tracker.summarize(idA), { kind: 'unavailable' });
    assert.deepEqual(tracker.summarize(idC), { kind: 'complete', promptTokens: 3, completionTokens: 3, totalTokens: 6 });
  });
});

describe('formatReplyTokenSummaryLine', () => {
  test('formats a complete summary with thousands separators', () => {
    const line = formatReplyTokenSummaryLine({
      kind: 'complete', promptTokens: 12345, completionTokens: 1234, totalTokens: 13579,
    });
    assert.equal(line, 'Tokens: input 12,345 | output 1,234 | total 13,579');
  });

  test('formats a partial summary with the partial label', () => {
    const line = formatReplyTokenSummaryLine({
      kind: 'partial', promptTokens: 100, completionTokens: 10, totalTokens: 110,
    });
    assert.equal(line, 'Tokens (partial): input 100 | output 10 | total 110');
  });

  test('formats an unavailable summary', () => {
    assert.equal(
      formatReplyTokenSummaryLine({ kind: 'unavailable' }),
      'Tokens: input unavailable | output unavailable | total unavailable'
    );
  });

  test('formats small numbers without a separator', () => {
    const line = formatReplyTokenSummaryLine({ kind: 'complete', promptTokens: 5, completionTokens: 0, totalTokens: 5 });
    assert.equal(line, 'Tokens: input 5 | output 0 | total 5');
  });
});
