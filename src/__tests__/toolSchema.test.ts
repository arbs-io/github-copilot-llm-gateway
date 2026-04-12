import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { fillMissingRequiredProperties, getDefaultForType } from '../toolSchema';

describe('getDefaultForType', () => {
  test('returns null for null / undefined schema', () => {
    assert.equal(getDefaultForType(null), null);
    assert.equal(getDefaultForType(undefined), null);
    assert.equal(getDefaultForType({}), null);
  });

  test('returns empty string for string type', () => {
    assert.equal(getDefaultForType({ type: 'string' }), '');
  });

  test('returns 0 for number type', () => {
    assert.equal(getDefaultForType({ type: 'number' }), 0);
    assert.equal(getDefaultForType({ type: 'integer' }), 0);
  });

  test('returns false for boolean type', () => {
    assert.equal(getDefaultForType({ type: 'boolean' }), false);
  });

  test('returns empty array for array type', () => {
    assert.deepEqual(getDefaultForType({ type: 'array' }), []);
  });

  test('returns empty object for object type', () => {
    assert.deepEqual(getDefaultForType({ type: 'object' }), {});
  });

  test('returns null for null type', () => {
    assert.equal(getDefaultForType({ type: 'null' }), null);
  });

  test('respects schema.default when present', () => {
    assert.equal(getDefaultForType({ type: 'string', default: 'hi' }), 'hi');
    assert.equal(getDefaultForType({ type: 'number', default: 42 }), 42);
    assert.equal(getDefaultForType({ type: 'boolean', default: true }), true);
    assert.deepEqual(getDefaultForType({ type: 'array', default: [1, 2] }), [1, 2]);
    assert.deepEqual(getDefaultForType({ type: 'object', default: { a: 1 } }), { a: 1 });
  });

  test('returns null for union type including null', () => {
    assert.equal(getDefaultForType({ type: ['string', 'null'] }), null);
  });

  test('recurses into first non-null variant of union type', () => {
    assert.equal(getDefaultForType({ type: ['number'] }), 0);
  });

  test('returns null for unknown primitive type', () => {
    assert.equal(getDefaultForType({ type: 'unknown-type' }), null);
  });
});

describe('fillMissingRequiredProperties', () => {
  test('returns args unchanged when schema has no required array', () => {
    const args = { a: 1 };
    assert.equal(fillMissingRequiredProperties(args, {}), args);
    assert.equal(fillMissingRequiredProperties(args, null), args);
    assert.equal(fillMissingRequiredProperties(args, undefined), args);
  });

  test('returns args unchanged when required is not an array', () => {
    const args = { a: 1 };
    assert.equal(fillMissingRequiredProperties(args, { required: 'not-an-array' }), args);
  });

  test('fills missing string required property with empty string', () => {
    const result = fillMissingRequiredProperties(
      {},
      {
        required: ['name'],
        properties: { name: { type: 'string' } },
      }
    );
    assert.deepEqual(result, { name: '' });
  });

  test('fills multiple missing required properties', () => {
    const result = fillMissingRequiredProperties(
      {},
      {
        required: ['name', 'count', 'enabled'],
        properties: {
          name: { type: 'string' },
          count: { type: 'integer' },
          enabled: { type: 'boolean' },
        },
      }
    );
    assert.deepEqual(result, { name: '', count: 0, enabled: false });
  });

  test('does not overwrite existing values', () => {
    const result = fillMissingRequiredProperties(
      { name: 'provided' },
      {
        required: ['name', 'count'],
        properties: {
          name: { type: 'string' },
          count: { type: 'integer' },
        },
      }
    );
    assert.deepEqual(result, { name: 'provided', count: 0 });
  });

  test('does not mutate the original args object', () => {
    const args: Record<string, unknown> = { a: 1 };
    fillMissingRequiredProperties(args, {
      required: ['b'],
      properties: { b: { type: 'string' } },
    });
    assert.deepEqual(args, { a: 1 });
  });

  test('logs a summary when properties are filled', () => {
    const logs: string[] = [];
    fillMissingRequiredProperties(
      {},
      {
        required: ['x'],
        properties: { x: { type: 'string' } },
      },
      (m) => logs.push(m)
    );
    assert.ok(logs.some((m) => m.includes('AUTO-FILLED')));
    assert.ok(logs.some((m) => m.includes('x=')));
  });

  test('does not log when nothing was filled', () => {
    const logs: string[] = [];
    fillMissingRequiredProperties(
      { name: 'x' },
      { required: ['name'], properties: { name: { type: 'string' } } },
      (m) => logs.push(m)
    );
    assert.equal(logs.length, 0);
  });

  test('uses schema default when filling', () => {
    const result = fillMissingRequiredProperties(
      {},
      {
        required: ['mode'],
        properties: { mode: { type: 'string', default: 'auto' } },
      }
    );
    assert.deepEqual(result, { mode: 'auto' });
  });
});
