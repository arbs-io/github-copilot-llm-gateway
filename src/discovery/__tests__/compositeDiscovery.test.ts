import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import type { CancellationToken } from 'vscode';
import { CompositeDiscovery } from '../compositeDiscovery';
import { DiscoveredModelInfo, ModelDiscovery } from '../types';

function probe(
  answers: Record<string, DiscoveredModelInfo | undefined>
): { probe: ModelDiscovery; calls: string[]; resets: number } {
  const state = { calls: [] as string[], resets: 0 };
  const impl: ModelDiscovery = {
    reset: () => { state.resets += 1; },
    enrichModel: (id) => {
      state.calls.push(id);
      return Promise.resolve(answers[id]);
    },
  };
  return { probe: impl, calls: state.calls, get resets() { return state.resets; } };
}

const INFO: DiscoveredModelInfo = { contextLength: 4096, samplerParams: {} };

describe('CompositeDiscovery', () => {
  test('returns the first probe that knows the model and skips the rest', async () => {
    const first = probe({ a: INFO });
    const second = probe({ a: { contextLength: 1, samplerParams: {} } });
    const composite = new CompositeDiscovery([first.probe, second.probe]);
    const info = await composite.enrichModel('a');
    assert.equal(info?.contextLength, 4096);
    assert.deepEqual(second.calls, []);
  });

  test('falls through to later probes when earlier ones answer undefined', async () => {
    const first = probe({});
    const second = probe({ a: INFO });
    const composite = new CompositeDiscovery([first.probe, second.probe]);
    assert.equal((await composite.enrichModel('a'))?.contextLength, 4096);
    assert.deepEqual(first.calls, ['a']);
    assert.deepEqual(second.calls, ['a']);
  });

  test('undefined when no probe knows the model', async () => {
    const composite = new CompositeDiscovery([probe({}).probe, probe({}).probe]);
    assert.equal(await composite.enrichModel('a'), undefined);
  });

  test('stops after a cancelled token instead of probing further', async () => {
    const first = probe({});
    const second = probe({ a: INFO });
    const composite = new CompositeDiscovery([first.probe, second.probe]);
    const token: CancellationToken = {
      isCancellationRequested: true,
      onCancellationRequested: () => ({ dispose: () => undefined }),
    };
    assert.equal(await composite.enrichModel('a', token), undefined);
    assert.deepEqual(second.calls, []);
  });

  test('reset() resets every probe', () => {
    const first = probe({});
    const second = probe({});
    new CompositeDiscovery([first.probe, second.probe]).reset();
    assert.equal(first.resets, 1);
    assert.equal(second.resets, 1);
  });
});
