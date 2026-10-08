/**
 * Convert normalized chat messages into the OpenAI wire format.
 *
 * This module is intentionally free of any VS Code imports — callers pass in
 * {@link NormalizedMessage}s, which are plain-data descriptions of each part
 * (text, tool call, tool result, image). The provider is responsible for
 * translating `vscode.LanguageModel*Part` instances into these descriptors;
 * that's where the `instanceof` checks and duck-typed fallbacks live.
 *
 * This split makes the converter trivially unit-testable and eliminates the
 * God-object shape that provider.ts used to have.
 */

import { OpenAIMessage } from '../api/types';
import { stripReplyTokenSummary } from './replyTokenUsage';

export type NormalizedRole = 'user' | 'assistant' | 'system' | 'tool';

export type NormalizedPart =
  | { kind: 'text'; value: string }
  | { kind: 'toolResult'; callId: string; content: string }
  | { kind: 'toolCall'; callId: string; name: string; input: unknown }
  | { kind: 'image'; mimeType: string; data: Uint8Array }
  | { kind: 'thinking'; value: string }
  | { kind: 'unknown' };

export interface NormalizedMessage {
  role: NormalizedRole;
  parts: NormalizedPart[];
}

export type ConverterLogger = (message: string) => void;

/**
 * Flatten a tool result's `content` into a plain string for the OpenAI `tool`
 * message.
 *
 * VS Code delivers `LanguageModelToolResultPart.content` as an *array* of parts
 * (text parts, prompt-tsx parts, data parts, or opaque objects). Some of those
 * objects are values that crossed the extension-host RPC boundary and carry
 * VS Code's internal `$mid` marshalling marker (e.g. a Uri or a terminal link
 * such as `{ "$mid": 21, "value": "#!/bin/bash..." }`). Blindly
 * `JSON.stringify`-ing the array dumps those blobs into the model context, and
 * the model then echoes the raw JSON back into the chat (issue #41).
 *
 * We instead pull the human-meaningful text out of each element: a string
 * `value` field covers both `LanguageModelTextPart` and the marshalled
 * `{ $mid, value }` shape, yielding the clean underlying text.
 *
 * `LanguageModelDataPart`s are skipped: they cross the RPC boundary as
 * `{ $mid, mimeType, data }` and carry binary or control metadata with no text
 * representation — notably the `cache_control` cache-breakpoint part whose
 * `data` decodes to `ephemeral`. JSON-dumping those leaked raw marshalling
 * garbage into the model context, which the model echoed back into chat
 * (issue #47). Genuinely structured elements with no string `value` (and which
 * are not data parts) fall back to a JSON dump so no information is silently
 * lost.
 */
export function flattenToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  const parts = Array.isArray(content) ? content : [content];
  return parts.map(extractToolResultPartText).join('');
}

function extractToolResultPartText(part: unknown): string {
  if (typeof part === 'string') {
    return part;
  }
  if (part === null || part === undefined) {
    return '';
  }
  if (typeof part === 'object') {
    const obj = part as { value?: unknown; mimeType?: unknown; data?: unknown };
    if (typeof obj.value === 'string') {
      return obj.value;
    }
    // Drop `LanguageModelDataPart`-shaped elements (a string `mimeType` plus a
    // `data` payload). These are image bytes or control metadata such as the
    // `cache_control` cache-breakpoint part — never text — and JSON-dumping
    // them leaked marshalling garbage into chat (issue #47).
    if (typeof obj.mimeType === 'string' && 'data' in obj) {
      return '';
    }
  }
  return JSON.stringify(part);
}

/**
 * Normalize a thinking part's `value` to plain text. The proposed
 * `LanguageModelThinkingPart` API types it as `string | string[]`; array
 * chunks are concatenated. Anything else yields an empty string.
 */
export function normalizeThinkingValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.filter((chunk): chunk is string => typeof chunk === 'string').join('');
  }
  return '';
}

/**
 * Duck-typed check for a `LanguageModelThinkingPart`: a `value` that is a
 * string or string array, plus the `id` / `metadata` keys its constructor
 * always assigns. Text parts carry only `value`, so they never match.
 */
export function isThinkingPartShape(part: unknown): part is { value: string | string[] } {
  if (typeof part !== 'object' || part === null) {
    return false;
  }
  const obj = part as Record<string, unknown>;
  const value = obj.value;
  const hasThinkingValue =
    typeof value === 'string' || (Array.isArray(value) && value.every((v) => typeof v === 'string'));
  return hasThinkingValue && ('id' in obj || 'metadata' in obj);
}

export interface MessageConverterOptions {
  enableImageInput: boolean;
  /**
   * Send the model's earlier reasoning back as `reasoning_content` on
   * assistant history messages. Copilot Chat only replays thinking for the
   * current turn's tool-call rounds, so this mainly covers agent loops.
   * Off by default: some servers reject the unknown field.
   */
  replayReasoning?: boolean;
}

const NOOP_LOGGER: ConverterLogger = () => {
  /* no-op */
};

type UserContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * Encode an image data part as a `data:` URL suitable for the OpenAI
 * multimodal `image_url` message shape.
 *
 * Uses Node's Buffer for base64 encoding — the previous `btoa(String.fromCodePoint(...data))`
 * approach spread the whole byte array onto the JS call stack and threw
 * `RangeError: Maximum call stack size exceeded` on images larger than ~65 KB.
 */
export function encodeImageAsDataUrl(part: { mimeType: string; data: Uint8Array }): string {
  const base64Data = Buffer.from(part.data).toString('base64');
  return `data:${part.mimeType};base64,${base64Data}`;
}

/**
 * Whether a data part's MIME type carries plain text. Chat attachments such as
 * text pasted from outside the editor arrive as `LanguageModelDataPart`s with
 * a `text/*` or JSON type rather than as text parts (issue #109). Control
 * parts like `cache_control` use non-MIME markers and are not matched.
 */
export function isTextMimeType(mimeType: string): boolean {
  const type = mimeType.split(';')[0].trim().toLowerCase();
  return type.startsWith('text/') || type === 'application/json' || type.endsWith('+json');
}

/** Decode a text data part's bytes as UTF-8. */
export function decodeTextData(data: Uint8Array): string {
  // TextDecoder strips a leading byte-order mark, which Buffer would keep.
  return new TextDecoder().decode(data);
}

/** Wire-level pieces accumulated while walking one message's parts. */
interface ConvertedParts {
  readonly toolResults: OpenAIMessage[];
  readonly toolCalls: OpenAIMessage[];
  readonly userContent: UserContentPart[];
  readonly thinking: string[];
  /** Whether any thinking part was seen, empty ones included. */
  sawThinking: boolean;
  textContent: string;
}

function appendTextPart(
  acc: ConvertedParts,
  role: NormalizedRole,
  part: Extract<NormalizedPart, { kind: 'text' }>
): void {
  // The per-reply token summary is appended to assistant replies as
  // ordinary text (issue #88); keep it out of the history we replay.
  const value = role === 'assistant' ? stripReplyTokenSummary(part.value) : part.value;
  if (value.length === 0) {
    return;
  }
  acc.userContent.push({ type: 'text', text: value });
  acc.textContent += value;
}

function appendToolResultPart(
  acc: ConvertedParts,
  part: Extract<NormalizedPart, { kind: 'toolResult' }>,
  log: ConverterLogger
): void {
  log(`  Found tool result: callId=${part.callId}`);
  acc.toolResults.push({
    tool_call_id: part.callId,
    role: 'tool',
    content: part.content,
  });
}

function appendToolCallPart(
  acc: ConvertedParts,
  part: Extract<NormalizedPart, { kind: 'toolCall' }>,
  log: ConverterLogger
): void {
  log(`  Found tool call: callId=${part.callId}, name=${part.name}`);
  acc.toolCalls.push({
    id: part.callId,
    type: 'function',
    function: {
      name: part.name,
      arguments: JSON.stringify(part.input),
    },
  });
}

function appendDataPart(
  acc: ConvertedParts,
  role: NormalizedRole,
  part: Extract<NormalizedPart, { kind: 'image' }>,
  options: MessageConverterOptions,
  log: ConverterLogger
): void {
  // Text attachments are sent as text whatever enableImageInput says —
  // that setting only governs image payloads.
  if (isTextMimeType(part.mimeType)) {
    const value = decodeTextData(part.data);
    if (value.length === 0) {
      log(`  Skipping empty text data part: mimeType=${part.mimeType}`);
      return;
    }
    appendTextPart(acc, role, { kind: 'text', value });
    log(`  Added text data part: mimeType=${part.mimeType}, size=${part.data.length} bytes`);
    return;
  }
  if (!part.mimeType.startsWith('image/')) {
    log(`  Skipping unsupported data part: mimeType=${part.mimeType}, size=${part.data.length} bytes`);
    return;
  }
  if (!options.enableImageInput) {
    log(
      `  Skipping data part: mimeType=${part.mimeType}, size=${part.data.length} bytes. (Please enable github.copilot.llm-gateway.enableImageInput in settings)`
    );
    return;
  }
  const url = encodeImageAsDataUrl(part);
  acc.userContent.push({ type: 'image_url', image_url: { url } });
  log(
    `  Added image data part as base64 URL: mimeType=${part.mimeType}, size=${part.data.length} bytes, urlLength=${url.length}`
  );
}

/**
 * Collect a thinking part's text. Only assistant messages replay reasoning,
 * and only when `replayReasoning` is on; otherwise the part is dropped.
 */
function appendThinkingPart(
  acc: ConvertedParts,
  role: NormalizedRole,
  part: Extract<NormalizedPart, { kind: 'thinking' }>,
  options: MessageConverterOptions
): void {
  if (!options.replayReasoning || role !== 'assistant') {
    return;
  }
  acc.sawThinking = true;
  // Empty values include our own `vscode_reasoning_done` marker.
  if (part.value.length > 0) {
    acc.thinking.push(part.value);
  }
}

/** Pick the wire message shape for the accumulated parts. */
function buildWireMessages(role: NormalizedRole, acc: ConvertedParts): OpenAIMessage[] {
  const { toolCalls, toolResults, userContent, textContent } = acc;
  if (toolCalls.length > 0) {
    return [{ role: 'assistant', content: textContent || null, tool_calls: toolCalls }];
  }
  if (toolResults.length > 0) {
    return [...toolResults];
  }
  if (userContent.length > 0) {
    return [{ role, content: userContent }];
  }
  if (textContent) {
    return [{ role, content: textContent }];
  }
  return [];
}

/**
 * Attach collected reasoning to the first wire message.
 *
 * Only assistant messages collect thinking; a thinking-only message has
 * nothing to attach it to and is still dropped. A tool-call round that had
 * thinking parts keeps the field even when they were all empty, because
 * DeepSeek checks for its presence on every assistant message in the turn.
 */
function attachReasoning(result: OpenAIMessage[], acc: ConvertedParts): void {
  const firstMessage = result[0];
  if (firstMessage?.role !== 'assistant') {
    return;
  }
  if (acc.thinking.length > 0) {
    firstMessage.reasoning_content = acc.thinking.join('\n');
  } else if (acc.sawThinking && acc.toolCalls.length > 0) {
    firstMessage.reasoning_content = '';
  }
}

/**
 * Convert a normalized message into zero or more OpenAI wire messages.
 *
 * The conversion is lossy-but-deliberate:
 *  - pure-text user/assistant messages collapse into `{ role, content: text }`
 *  - messages that carry image parts become `{ role, content: UserContentPart[] }`
 *  - assistant messages with tool calls become `{ role: 'assistant', tool_calls }`
 *  - tool result parts are flattened into their own `{ role: 'tool' }` messages
 *
 * When `enableImageInput` is false, image parts are dropped with a log line.
 * Data parts with a text MIME type (e.g. pasted attachments) become text.
 * Thinking parts are dropped unless `replayReasoning` is on, in which case
 * they become the assistant message's `reasoning_content`.
 */
export function convertMessage(
  message: NormalizedMessage,
  options: MessageConverterOptions,
  log: ConverterLogger = NOOP_LOGGER
): OpenAIMessage[] {
  const acc: ConvertedParts = {
    toolResults: [],
    toolCalls: [],
    userContent: [],
    thinking: [],
    sawThinking: false,
    textContent: '',
  };

  for (const part of message.parts) {
    switch (part.kind) {
      case 'text':
        appendTextPart(acc, message.role, part);
        break;
      case 'toolResult':
        appendToolResultPart(acc, part, log);
        break;
      case 'toolCall':
        appendToolCallPart(acc, part, log);
        break;
      case 'image':
        appendDataPart(acc, message.role, part, options, log);
        break;
      case 'thinking':
        appendThinkingPart(acc, message.role, part, options);
        break;
      case 'unknown':
        // Unknown parts are silently dropped; the classifier has already logged.
        break;
      default: {
        const _never: never = part;
        throw new Error(`Unexpected part kind: ${String(_never)}`);
      }
    }
  }

  const result = buildWireMessages(message.role, acc);
  attachReasoning(result, acc);
  return result;
}

/**
 * Convert a list of normalized messages into the flat OpenAI message stream
 * sent to the server.
 */
export function convertMessages(
  messages: readonly NormalizedMessage[],
  options: MessageConverterOptions,
  log: ConverterLogger = NOOP_LOGGER
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  for (const msg of messages) {
    result.push(...convertMessage(msg, options, log));
  }
  return result;
}
