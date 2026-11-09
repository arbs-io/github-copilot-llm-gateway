import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ThinkingBlockIds } from '../thinkingBlockId';

describe('ThinkingBlockIds (issue #144)', () => {
  test('every delta of one reasoning phase shares an id', () => {
    const ids = new ThinkingBlockIds();
    const first = ids.current();
    assert.equal(ids.current(), first);
    assert.equal(ids.current(), first);
  });

  test('ending a phase returns its id and the next phase gets a new one', () => {
    const ids = new ThinkingBlockIds();
    const first = ids.current();
    assert.equal(ids.end(), first);
    const second = ids.current();
    assert.notEqual(second, first);
  });

  test('ending with no open phase returns undefined', () => {
    const ids = new ThinkingBlockIds();
    assert.equal(ids.end(), undefined);
  });

  test('separate trackers (one per request) never reuse an id', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 50; i++) {
      const id = new ThinkingBlockIds().current();
      assert.ok(!seen.has(id), `duplicate id ${id}`);
      seen.add(id);
    }
  });

  test('ids are non-empty, so VS Code never treats them as absent', () => {
    assert.ok(new ThinkingBlockIds().current().length > 0);
  });
});
