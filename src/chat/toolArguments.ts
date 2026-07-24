export interface PreparedToolArguments {
  value?: Record<string, unknown>;
  error?: string;
  wasRepaired: boolean;
}

export interface ToolCallArguments {
  id: string;
  name: string;
  arguments: string;
}

export interface PreparedToolCall extends Omit<ToolCallArguments, 'arguments'> {
  arguments: Record<string, unknown>;
}

export type PreparedToolCallBatch =
  | { calls: PreparedToolCall[]; error?: undefined }
  | { calls?: undefined; error: { toolCall: ToolCallArguments; reason: string } };

export const MAX_TOOL_ARGUMENT_DEPTH = 64;
export const MAX_TOOL_ARGUMENT_NODES = 10_000;
export const MAX_TOOL_SCHEMA_DEPTH = 64;
export const MAX_TOOL_SCHEMA_NODES = 20_000;

const UNSAFE_OBJECT_KEYS = new Set([
  '__proto__',
  'constructor',
  'prototype',
  'toJSON',
  'toString',
  'valueOf',
]);

export function prepareToolCallBatch(
  toolCalls: readonly ToolCallArguments[],
  schemas: ReadonlyMap<string, Record<string, unknown> | undefined>
): PreparedToolCallBatch {
  const calls: PreparedToolCall[] = [];
  const ids = new Set<string>();

  for (const toolCall of toolCalls) {
    if (!toolCall.id || ids.has(toolCall.id)) {
      return failure(toolCall, toolCall.id ? 'duplicate tool-call id' : 'tool-call id was empty');
    }
    ids.add(toolCall.id);

    if (!toolCall.name || !schemas.has(toolCall.name)) {
      return failure(toolCall, 'the tool was not selected for this request');
    }

    const prepared = prepareToolArguments(toolCall.arguments, schemas.get(toolCall.name));
    if (!prepared.value) {
      return failure(toolCall, prepared.error ?? 'arguments could not be validated');
    }
    calls.push({ id: toolCall.id, name: toolCall.name, arguments: prepared.value });
  }

  return { calls };
}

/**
 * Parse and validate arguments at the execution boundary. Required values are
 * never fabricated; only explicit JSON-schema defaults may fill an omission.
 */
export function prepareToolArguments(
  jsonText: string,
  schema?: Record<string, unknown>
): PreparedToolArguments {
  const parsed = parseJsonObject(jsonText);
  if (!parsed) {
    return { error: 'arguments were not a valid JSON object', wasRepaired: false };
  }
  const argumentStructureError = inspectJsonStructure(
    parsed,
    'arguments',
    MAX_TOOL_ARGUMENT_DEPTH,
    MAX_TOOL_ARGUMENT_NODES
  );
  if (argumentStructureError) {
    return { error: argumentStructureError, wasRepaired: false };
  }

  const value = { ...parsed };
  if (schema) {
    const schemaStructureError = inspectJsonStructure(
      schema,
      'tool schema',
      MAX_TOOL_SCHEMA_DEPTH,
      MAX_TOOL_SCHEMA_NODES
    );
    if (schemaStructureError) {
      return { error: schemaStructureError, wasRepaired: false };
    }
    const budget = { remaining: MAX_TOOL_ARGUMENT_NODES };
    const error = validateSchemaValue(value, schema, '$', 0, budget);
    if (error) { return { error, wasRepaired: false }; }
    const finalStructureError = inspectJsonStructure(
      value,
      'arguments',
      MAX_TOOL_ARGUMENT_DEPTH,
      MAX_TOOL_ARGUMENT_NODES
    );
    if (finalStructureError) {
      return { error: finalStructureError, wasRepaired: false };
    }
  }
  return { value, wasRepaired: false };
}

/**
 * Conservative repair used only to normalize loop-detection signatures.
 * Execution should always use {@link prepareToolArguments}, which is strict.
 */
export function repairJsonObject(jsonText: string): Record<string, unknown> | null {
  const direct = parseJsonObject(jsonText);
  if (direct) { return direct; }

  let repaired = jsonText.trim().replace(/,\s*([}\]])/g, '$1');
  repaired = balanceDelimiters(repaired);
  if (count(repaired, '"') % 2 !== 0) {
    repaired += '"';
    repaired = balanceDelimiters(repaired);
  }
  return parseJsonObject(repaired);
}

function validateSchemaValue(
  value: unknown,
  schema: Record<string, unknown>,
  path: string,
  depth: number,
  budget: { remaining: number }
): string | undefined {
  if (depth > MAX_TOOL_ARGUMENT_DEPTH) {
    return `arguments exceeded the maximum nesting depth of ${MAX_TOOL_ARGUMENT_DEPTH}`;
  }
  budget.remaining--;
  if (budget.remaining < 0) {
    return `arguments exceeded the maximum node count of ${MAX_TOOL_ARGUMENT_NODES}`;
  }
  if ('const' in schema && !deepEqual(value, schema.const)) {
    return `${path} did not match the schema const`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => deepEqual(value, entry))) {
    return `${path} was not one of the allowed enum values`;
  }
  if (!matchesSchemaType(value, schema.type)) {
    return `${path} did not match schema type ${formatSchemaType(schema.type)}`;
  }

  if (isRecord(value)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === 'string')
      : [];

    for (const propertyName of required) {
      if (UNSAFE_OBJECT_KEYS.has(propertyName)) {
        return `${path} contained an unsafe schema property name`;
      }
      if (Object.prototype.hasOwnProperty.call(value, propertyName)) { continue; }
      const propertySchema = properties[propertyName];
      if (isRecord(propertySchema) && 'default' in propertySchema) {
        const clonedDefault = cloneJsonValue(propertySchema.default);
        if (!clonedDefault.ok) {
          return `${path}.${propertyName} had an invalid schema default`;
        }
        value[propertyName] = clonedDefault.value;
      } else {
        return `${path} missing required argument: ${propertyName}`;
      }
    }

    for (const [propertyName, propertyValue] of Object.entries(value)) {
      const propertySchema = properties[propertyName];
      if (isRecord(propertySchema)) {
        const error = validateSchemaValue(
          propertyValue,
          propertySchema,
          `${path}.${propertyName}`,
          depth + 1,
          budget
        );
        if (error) { return error; }
      } else if (schema.additionalProperties === false) {
        return `${path}.${propertyName} was not allowed by the schema`;
      }
    }
  }

  if (Array.isArray(value) && isRecord(schema.items)) {
    for (let index = 0; index < value.length; index++) {
      const error = validateSchemaValue(
        value[index],
        schema.items,
        `${path}[${index}]`,
        depth + 1,
        budget
      );
      if (error) { return error; }
    }
  }
  return undefined;
}

function matchesSchemaType(value: unknown, type: unknown): boolean {
  if (type === undefined) { return true; }
  if (Array.isArray(type)) { return type.some((entry) => matchesSchemaType(value, entry)); }
  switch (type) {
    case 'null': return value === null;
    case 'array': return Array.isArray(value);
    case 'object': return isRecord(value);
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    default: return true;
  }
}

function failure(toolCall: ToolCallArguments, reason: string): PreparedToolCallBatch {
  return { error: { toolCall, reason } };
}

function parseJsonObject(jsonText: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(jsonText) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function balanceDelimiters(value: string): string {
  return `${value}${']'.repeat(Math.max(0, count(value, '[') - count(value, ']')))}${'}'.repeat(
    Math.max(0, count(value, '{') - count(value, '}'))
  )}`;
}

function count(value: string, character: string): number {
  return value.split(character).length - 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function formatSchemaType(type: unknown): string {
  return Array.isArray(type) ? type.join('|') : String(type);
}

function deepEqual(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function inspectJsonStructure(
  root: unknown,
  label: string,
  maxDepth: number,
  maxNodes: number
): string | undefined {
  const stack: Array<{ value: unknown; depth: number }> = [{ value: root, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes++;
    if (nodes > maxNodes) {
      return `${label} exceeded the maximum node count of ${maxNodes}`;
    }
    if (current.depth > maxDepth) {
      return `${label} exceeded the maximum nesting depth of ${maxDepth}`;
    }
    if (current.value === null) { continue; }
    const valueType = typeof current.value;
    if (
      valueType === 'string' ||
      valueType === 'boolean' ||
      (valueType === 'number' && Number.isFinite(current.value))
    ) {
      continue;
    }
    if (valueType !== 'object') {
      return `${label} contained a non-JSON value`;
    }

    const objectValue = current.value as object;
    if (seen.has(objectValue)) {
      return `${label} contained a cyclic value`;
    }
    seen.add(objectValue);

    const isArray = Array.isArray(current.value);
    let prototype: object | null;
    let descriptors: Record<string, PropertyDescriptor>;
    let symbolCount: number;
    try {
      prototype = Object.getPrototypeOf(objectValue) as object | null;
      descriptors = Object.getOwnPropertyDescriptors(objectValue);
      symbolCount = Object.getOwnPropertySymbols(objectValue).length;
    } catch {
      return `${label} contained an unreadable object`;
    }
    if (
      (isArray && prototype !== Array.prototype) ||
      (!isArray && prototype !== Object.prototype && prototype !== null)
    ) {
      return `${label} contained a non-plain object`;
    }
    if (symbolCount > 0) {
      return `${label} contained a symbol property`;
    }

    for (const [key, descriptor] of Object.entries(descriptors)) {
      if (isArray && key === 'length') { continue; }
      if (
        descriptor.get ||
        descriptor.set ||
        !('value' in descriptor) ||
        descriptor.enumerable !== true
      ) {
        return `${label} contained an accessor or non-data property`;
      }
      if (
        (!isArray && UNSAFE_OBJECT_KEYS.has(key)) ||
        (isArray && !/^(0|[1-9]\d*)$/.test(key))
      ) {
        return `${label} contained an unsafe object key`;
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
  return undefined;
}

function cloneJsonValue(value: unknown): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: cloneSafeJsonValue(value) };
  } catch {
    return { ok: false };
  }
}

function cloneSafeJsonValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') { return value; }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Array.isArray(value)) {
    const result: unknown[] = [];
    for (let index = 0; index < value.length; index++) {
      const descriptor = descriptors[String(index)];
      result.push(descriptor ? cloneSafeJsonValue(descriptor.value) : null);
    }
    return result;
  }

  const result: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    result[key] = cloneSafeJsonValue(descriptor.value);
  }
  return result;
}
