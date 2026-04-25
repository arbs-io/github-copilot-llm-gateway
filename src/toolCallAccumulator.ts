/**
 * Streaming tool-call accumulator.
 *
 * OpenAI-compatible servers stream tool calls incrementally: each delta
 * carries an `index` identifying which tool call is being updated, and the
 * `id` may arrive in a later chunk than the function name or arguments. The
 * accumulator collects those deltas across chunks and yields the finished
 * tool calls when the server signals completion (via `finish_reason`) or at
 * end-of-stream.
 *
 * Pure module: no VS Code or HTTP dependencies, so it can be unit-tested
 * directly.
 */

import { randomBytes } from 'node:crypto';

export interface AccumulatedToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface ToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface LegacyFunctionCall {
  name?: string;
  arguments?: string;
}

export class ToolCallAccumulator {
  private readonly byIndex = new Map<number, AccumulatedToolCall>();
  private readonly finalized = new Set<number>();
  private counter = 0;
  private readonly requestId: string;

  constructor(requestId?: string) {
    this.requestId = requestId ?? `req_${Date.now()}_${randomBytes(4).toString('hex')}`;
  }

  /**
   * Apply one streamed `tool_calls[i]` delta. Subsequent deltas for the same
   * `index` are merged into the same accumulating entry.
   */
  applyDelta(tc: ToolCallDelta): void {
    const index = tc.index ?? this.counter++;
    const existing = this.byIndex.get(index);

    if (existing) {
      if (tc.id) { existing.id = tc.id; }
      if (tc.function?.name) { existing.name = tc.function.name; }
      if (tc.function?.arguments) { existing.arguments += tc.function.arguments; }
      return;
    }
    this.byIndex.set(index, {
      id: tc.id ?? '',
      name: tc.function?.name ?? '',
      arguments: tc.function?.arguments ?? '',
    });
  }

  /**
   * Apply a single legacy `function_call` payload. Always uses index 0
   * (legacy format only supports one call per response).
   */
  applyLegacy(call: LegacyFunctionCall, fallbackId: string): void {
    const index = 0;
    const existing = this.byIndex.get(index);
    if (existing) {
      if (call.name) { existing.name = call.name; }
      if (call.arguments) { existing.arguments += call.arguments; }
      return;
    }
    this.byIndex.set(index, {
      id: fallbackId || '',
      name: call.name ?? '',
      arguments: call.arguments ?? '',
    });
  }

  /**
   * Apply a complete (non-delta) `tool_calls` array as it appears in a
   * non-streaming `message` payload.
   */
  applyComplete(toolCalls: ReadonlyArray<ToolCallDelta>): AccumulatedToolCall[] {
    const finished: AccumulatedToolCall[] = [];
    for (let i = 0; i < toolCalls.length; i++) {
      const tc = toolCalls[i];
      const index = tc.index ?? i;
      if (this.finalized.has(index)) { continue; }
      this.finalized.add(index);
      finished.push({
        id: tc.id || `call_${this.requestId}_${index}`,
        name: tc.function?.name ?? '',
        arguments: tc.function?.arguments ?? '',
      });
    }
    return finished;
  }

  /**
   * Finalize and return all not-yet-finalized tool calls.
   * @param onlyIfPopulated when true (the end-of-stream cleanup case),
   *   skip entries that have neither a `name` nor `arguments` populated.
   */
  drain(onlyIfPopulated = false): AccumulatedToolCall[] {
    const finished: AccumulatedToolCall[] = [];
    for (const [index, tc] of this.byIndex.entries()) {
      if (this.finalized.has(index)) { continue; }
      if (onlyIfPopulated && !tc.name && !tc.arguments) { continue; }
      this.finalized.add(index);
      const id = tc.id || `call_${this.requestId}_${index}`;
      finished.push({ id, name: tc.name, arguments: tc.arguments });
    }
    return finished;
  }
}
