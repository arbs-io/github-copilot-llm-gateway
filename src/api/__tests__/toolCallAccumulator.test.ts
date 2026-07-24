import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ToolCallAccumulator, ToolCallLimitError } from '../toolCallAccumulator';

describe('ToolCallAccumulator', () => {
  test('merges streamed deltas by index', () => {
    const acc = new ToolCallAccumulator('req_test');
    acc.applyDelta({ index: 0, id: 'c1', function: { name: 'search' } });
    acc.applyDelta({ index: 0, function: { arguments: '{"q":' } });
    acc.applyDelta({ index: 0, function: { arguments: '"hi"}' } });

    const finished = acc.drain();
    assert.equal(finished.length, 1);
    assert.equal(finished[0].id, 'c1');
    assert.equal(finished[0].name, 'search');
    assert.equal(finished[0].arguments, '{"q":"hi"}');
  });

  test('handles deltas without an explicit index by counting', () => {
    const acc = new ToolCallAccumulator('req_test');
    acc.applyDelta({ id: 'a', function: { name: 'first' } });
    acc.applyDelta({ id: 'b', function: { name: 'second' } });

    const finished = acc.drain();
    assert.equal(finished.length, 2);
    assert.deepEqual(
      finished.map((c) => c.name).sort((a, b) => a.localeCompare(b)),
      ['first', 'second']
    );
  });

  test('falls back to a generated id when none is supplied', () => {
    const acc = new ToolCallAccumulator('req_xyz');
    acc.applyDelta({ index: 0, function: { name: 'no_id', arguments: '{}' } });

    const finished = acc.drain();
    assert.equal(finished.length, 1);
    assert.match(finished[0].id, /^call_req_xyz_0$/);
  });

  test('drain twice without new entries returns nothing the second time', () => {
    const acc = new ToolCallAccumulator('req_test');
    acc.applyDelta({ index: 0, id: 'c1', function: { name: 'f' } });
    assert.equal(acc.drain().length, 1);
    assert.equal(acc.drain().length, 0);
  });

  test('drain(true) skips empty entries', () => {
    const acc = new ToolCallAccumulator('req_test');
    // simulate an empty stub from a noisy server
    acc.applyDelta({ index: 0 });
    acc.applyDelta({ index: 1, function: { name: 'real' } });
    const finished = acc.drain(true);
    assert.equal(finished.length, 1);
    assert.equal(finished[0].name, 'real');
  });

  test('legacy function_call format flows through as index 0', () => {
    const acc = new ToolCallAccumulator('req_test');
    acc.applyLegacy({ name: 'legacy_fn' }, 'parsed-id');
    acc.applyLegacy({ arguments: '{"a":1}' }, 'parsed-id');
    const finished = acc.drain();
    assert.equal(finished.length, 1);
    assert.equal(finished[0].id, 'parsed-id');
    assert.equal(finished[0].name, 'legacy_fn');
    assert.equal(finished[0].arguments, '{"a":1}');
  });

  test('applyComplete returns finished tool calls and marks them final', () => {
    const acc = new ToolCallAccumulator('req_test');
    const finished = acc.applyComplete([
      { index: 0, id: 'c1', function: { name: 'search', arguments: '{}' } },
      { index: 1, id: 'c2', function: { name: 'edit', arguments: '{}' } },
    ]);
    assert.equal(finished.length, 2);
    // Drain should NOT re-yield the already-finalized entries.
    assert.equal(acc.drain().length, 0);
  });

  test('applyComplete generates ids for entries without one', () => {
    const acc = new ToolCallAccumulator('req_id');
    const finished = acc.applyComplete([
      { index: 0, function: { name: 'no_id' } },
    ]);
    assert.equal(finished.length, 1);
    assert.equal(finished[0].id, 'call_req_id_0');
  });

  test('accumulateComplete keeps message tool calls pending until explicitly drained', () => {
    const acc = new ToolCallAccumulator('req_pending');
    acc.accumulateComplete([
      { index: 0, id: 'c1', function: { name: 'search', arguments: '{"q":"hi"}' } },
    ]);

    assert.deepEqual(acc.drain(true), [{
      id: 'c1',
      name: 'search',
      arguments: '{"q":"hi"}',
    }]);
    assert.deepEqual(acc.drain(true), []);
  });

  test('rejects oversized per-call and aggregate arguments with typed failures', () => {
    const perCall = new ToolCallAccumulator('req_limit', {
      maxToolCalls: 4,
      maxArgumentsPerCall: 5,
      maxTotalArguments: 10,
    });
    perCall.applyDelta({ index: 0, function: { arguments: '12345' } });
    assert.throws(
      () => perCall.applyDelta({ index: 0, function: { arguments: '6' } }),
      (error: unknown) =>
        error instanceof ToolCallLimitError && error.kind === 'call-arguments'
    );

    const aggregate = new ToolCallAccumulator('req_total', {
      maxToolCalls: 4,
      maxArgumentsPerCall: 10,
      maxTotalArguments: 5,
    });
    aggregate.applyDelta({ index: 0, function: { arguments: '123' } });
    assert.throws(
      () => aggregate.applyDelta({ index: 1, function: { arguments: '456' } }),
      (error: unknown) =>
        error instanceof ToolCallLimitError && error.kind === 'total-arguments'
    );
  });

  test('caps the total number of distinct tool calls', () => {
    const acc = new ToolCallAccumulator('req_calls', {
      maxToolCalls: 1,
      maxArgumentsPerCall: 10,
      maxTotalArguments: 10,
    });
    acc.applyDelta({ index: 0, function: { name: 'first' } });
    assert.throws(
      () => acc.applyDelta({ index: 1, function: { name: 'second' } }),
      (error: unknown) => error instanceof ToolCallLimitError && error.kind === 'calls'
    );
  });
});
