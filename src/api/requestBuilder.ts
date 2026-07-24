/**
 * Typed builder for OpenAI chat completion requests.
 *
 * Replaces the `Record<string, unknown>` + `as unknown as` cast pattern that
 * was previously in provider.ts — every field that ends up on the wire is
 * named and typed here, so the call site can't silently pass an extra field
 * that the server will ignore or reject.
 */

import { OpenAIChatCompletionRequest, OpenAIMessage, OpenAIToolDefinition } from './types';

export type { OpenAIToolDefinition } from './types';

export type ToolChoice = 'auto' | 'required' | 'none';

const PROTECTED_REQUEST_FIELDS = new Set([
  '__proto__',
  'constructor',
  'max_tokens',
  'messages',
  'model',
  'parallel_tool_calls',
  'prototype',
  'stream',
  'stream_options',
  'temperature',
  'toJSON',
  'toString',
  'tool_choice',
  'tools',
  'valueOf',
]);

export interface ChatRequestOptions {
  model: string;
  messages: OpenAIMessage[];
  maxTokens: number;
  temperature: number;
  tools?: OpenAIToolDefinition[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  /** Free-form overrides merged in last (e.g. from VS Code modelOptions). */
  extraOptions?: Record<string, unknown>;
}

/**
 * Produce an OpenAIChatCompletionRequest ready to send to the inference server.
 * Tools-related fields are only included when `tools` is a non-empty array.
 */
export function buildChatRequest(options: ChatRequestOptions): OpenAIChatCompletionRequest {
  const request: OpenAIChatCompletionRequest = {
    model: options.model,
    messages: options.messages,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
  };

  applyToolOptions(request, options);
  applyExtraOptions(request, options.extraOptions);
  return request;
}

function applyToolOptions(
  request: OpenAIChatCompletionRequest,
  options: ChatRequestOptions
): void {
  if (!options.tools?.length) { return; }
  request.tools = options.tools;
  if (options.toolChoice !== undefined) {
    request.tool_choice = options.toolChoice;
  }
  if (options.parallelToolCalls !== undefined) {
    request.parallel_tool_calls = options.parallelToolCalls;
  }
}

function applyExtraOptions(
  request: OpenAIChatCompletionRequest,
  options: Record<string, unknown> | undefined
): void {
  if (!options) { return; }
  for (const [key, value] of safeDataEntries(options) ?? []) {
    if (!isAllowedWireKey(key)) { continue; }
    const copied = copyWireValue(value);
    if (copied.ok) {
      request[key] = copied.value;
    }
  }
}

function copyWireValue(
  value: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet()
): { ok: true; value: unknown } | { ok: false } {
  if (depth > 64) { return { ok: false }; }
  if (isWireScalar(value)) { return { ok: true, value }; }
  if (typeof value !== 'object') { return { ok: false }; }
  if (seen.has(value)) { return { ok: false }; }
  seen.add(value);

  if (Array.isArray(value)) {
    return copyWireArray(value, depth, seen);
  }
  return copyWireRecord(value, depth, seen);
}

function copyWireArray(
  value: unknown[],
  depth: number,
  seen: WeakSet<object>
): { ok: true; value: unknown[] } | { ok: false } {
  const entries = safeDataEntries(value);
  if (!entries) { return { ok: false }; }
  const valuesByIndex = new Map(entries);
  const copied: unknown[] = [];
  for (let index = 0; index < value.length; index++) {
    const entry = valuesByIndex.get(String(index)) ?? null;
    const result = copyWireValue(entry, depth + 1, seen);
    if (!result.ok) { return { ok: false }; }
    copied.push(result.value);
  }
  return { ok: true, value: copied };
}

function copyWireRecord(
  value: object,
  depth: number,
  seen: WeakSet<object>
): { ok: true; value: Record<string, unknown> } | { ok: false } {
  const copied: Record<string, unknown> = {};
  const entries = safeDataEntries(value);
  if (!entries) { return { ok: false }; }
  for (const [key, entry] of entries) {
    if (!isAllowedWireKey(key)) { return { ok: false }; }
    const result = copyWireValue(entry, depth + 1, seen);
    if (!result.ok) { return { ok: false }; }
    copied[key] = result.value;
  }
  return { ok: true, value: copied };
}

function safeDataEntries(value: object): Array<[string, unknown]> | undefined {
  try {
    if (!hasSafeStructure(value)) { return undefined; }
    return readDataEntries(value);
  } catch {
    return undefined;
  }
}

function hasSafeStructure(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (Array.isArray(value)) {
    return prototype === Array.prototype && Object.getOwnPropertySymbols(value).length === 0;
  }
  return (
    (prototype === Object.prototype || prototype === null) &&
    Object.getOwnPropertySymbols(value).length === 0
  );
}

function readDataEntries(value: object): Array<[string, unknown]> | undefined {
  const isArray = Array.isArray(value);
  const entries: Array<[string, unknown]> = [];
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (isArray && key === 'length') { continue; }
    if (!isSafeDataDescriptor(key, descriptor, isArray)) { return undefined; }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function isSafeDataDescriptor(
  key: string,
  descriptor: PropertyDescriptor,
  isArray: boolean
): descriptor is PropertyDescriptor & { value: unknown } {
  if (descriptor.get || descriptor.set || !('value' in descriptor)) { return false; }
  if (descriptor.enumerable !== true) { return false; }
  return !isArray || /^(0|[1-9]\d*)$/.test(key);
}

function isAllowedWireKey(key: string): boolean {
  return !key.startsWith('_') && !PROTECTED_REQUEST_FIELDS.has(key);
}

function isWireScalar(
  value: unknown
): value is null | string | boolean | number {
  if (value === null) { return true; }
  if (typeof value === 'number') { return Number.isFinite(value); }
  return typeof value === 'string' || typeof value === 'boolean';
}
