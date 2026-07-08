import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { balanceBrackets, countChar, tryRepairJson } from '../jsonRepair';

describe('countChar', () => {
  test('counts literal occurrences of a character', () => {
    assert.equal(countChar('abcabc', 'a'), 2);
    assert.equal(countChar('abcabc', 'c'), 2);
    assert.equal(countChar('abcabc', 'z'), 0);
  });

  test('escapes regex metacharacters in search char', () => {
    assert.equal(countChar('a.b.c', '.'), 2);
    assert.equal(countChar('a+b+c', '+'), 2);
    assert.equal(countChar('a[b]c[d]', '['), 2);
    assert.equal(countChar('a{b}', '{'), 1);
    assert.equal(countChar(String.raw`a\b\c`, '\\'), 2);
  });

  test('returns 0 for empty input', () => {
    assert.equal(countChar('', 'a'), 0);
  });

  test('handles unicode characters', () => {
    assert.equal(countChar('héllo hé', 'é'), 2);
  });
});

describe('balanceBrackets', () => {
  test('adds missing closing braces', () => {
    assert.equal(balanceBrackets('{"a":1'), '{"a":1}');
    assert.equal(balanceBrackets('{"a":{"b":1'), '{"a":{"b":1}}');
  });

  test('adds missing closing brackets', () => {
    assert.equal(balanceBrackets('[1,2,3'), '[1,2,3]');
    assert.equal(balanceBrackets('[[1,2'), '[[1,2]]');
  });

  test('adds both missing brackets and braces', () => {
    assert.equal(balanceBrackets('{"a":[1,2'), '{"a":[1,2]}');
  });

  test('does not touch balanced input', () => {
    assert.equal(balanceBrackets('{"a":1}'), '{"a":1}');
    assert.equal(balanceBrackets('[1,2,3]'), '[1,2,3]');
    assert.equal(balanceBrackets(''), '');
  });

  test('does not remove characters when overclosed', () => {
    // If there are more closers than openers, don't touch it.
    assert.equal(balanceBrackets('1,2]'), '1,2]');
    assert.equal(balanceBrackets('a}'), 'a}');
  });
});

describe('tryRepairJson', () => {
  test('returns {} for empty / whitespace-only input', () => {
    assert.deepEqual(tryRepairJson(''), {});
    assert.deepEqual(tryRepairJson('   '), {});
    assert.deepEqual(tryRepairJson('\n\t'), {});
  });

  test('parses valid JSON directly', () => {
    assert.deepEqual(tryRepairJson('{"a":1}'), { a: 1 });
    assert.deepEqual(tryRepairJson('[1,2,3]'), [1, 2, 3]);
    assert.deepEqual(tryRepairJson('"hello"'), 'hello');
    assert.deepEqual(tryRepairJson('null'), null);
    assert.deepEqual(tryRepairJson('true'), true);
  });

  test('repairs truncated object', () => {
    assert.deepEqual(tryRepairJson('{"a":1,"b":2'), { a: 1, b: 2 });
  });

  test('repairs truncated nested object', () => {
    assert.deepEqual(tryRepairJson('{"a":{"b":{"c":1'), { a: { b: { c: 1 } } });
  });

  test('repairs truncated array', () => {
    assert.deepEqual(tryRepairJson('[1,2,3'), [1, 2, 3]);
  });

  test('repairs trailing comma in object', () => {
    assert.deepEqual(tryRepairJson('{"a":1,}'), { a: 1 });
  });

  test('repairs trailing comma in array', () => {
    assert.deepEqual(tryRepairJson('[1,2,3,]'), [1, 2, 3]);
  });

  test('repairs unclosed string', () => {
    // "hello -> "hello"
    assert.deepEqual(tryRepairJson('{"msg":"hello'), { msg: 'hello' });
  });

  test('repairs unclosed string with trailing comma and brace', () => {
    assert.deepEqual(tryRepairJson('{"a":"x","b":"yy'), { a: 'x', b: 'yy' });
  });

  test('returns null when repair ultimately fails', () => {
    const messages: string[] = [];
    const result = tryRepairJson('this is not JSON at all !!!', (m) => messages.push(m));
    assert.equal(result, null);
    assert.ok(messages.some((m) => m.includes('JSON repair failed')));
    assert.ok(messages.some((m) => m.includes('Repaired attempt')));
  });

  test('does not call logger on success', () => {
    const messages: string[] = [];
    tryRepairJson('{"a":1}', (m) => messages.push(m));
    assert.equal(messages.length, 0);
  });

  test('does not call logger when repair succeeds', () => {
    const messages: string[] = [];
    tryRepairJson('{"a":1', (m) => messages.push(m));
    assert.equal(messages.length, 0);
  });

  test('handles complex realistic tool call args', () => {
    const input = '{"query":"hello world","options":{"limit":10,"filters":[{"type":"date"';
    const result = tryRepairJson(input) as Record<string, unknown>;
    assert.equal(result.query, 'hello world');
    assert.deepEqual((result.options as Record<string, unknown>).limit, 10);
  });
});
