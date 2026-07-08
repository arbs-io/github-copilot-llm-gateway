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

export type NormalizedRole = 'user' | 'assistant' | 'system' | 'tool';

export type NormalizedPart =
  | { kind: 'text'; value: string }
  | { kind: 'toolResult'; callId: string; content: string }
  | { kind: 'toolCall'; callId: string; name: string; input: unknown }
  | { kind: 'image'; mimeType: string; data: Uint8Array }
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

export interface MessageConverterOptions {
  enableImageInput: boolean;
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
 * Convert a normalized message into zero or more OpenAI wire messages.
 *
 * The conversion is lossy-but-deliberate:
 *  - pure-text user/assistant messages collapse into `{ role, content: text }`
 *  - messages that carry image parts become `{ role, content: UserContentPart[] }`
 *  - assistant messages with tool calls become `{ role: 'assistant', tool_calls }`
 *  - tool result parts are flattened into their own `{ role: 'tool' }` messages
 *
 * When `enableImageInput` is false, image parts are dropped with a log line.
 */
export function convertMessage(
  message: NormalizedMessage,
  options: MessageConverterOptions,
  log: ConverterLogger = NOOP_LOGGER
): OpenAIMessage[] {
  const toolResults: OpenAIMessage[] = [];
  const toolCalls: OpenAIMessage[] = [];
  const userContent: UserContentPart[] = [];
  let textContent = '';

  for (const part of message.parts) {
    switch (part.kind) {
      case 'text':
        userContent.push({ type: 'text', text: part.value });
        textContent += part.value;
        break;

      case 'toolResult':
        log(`  Found tool result: callId=${part.callId}`);
        toolResults.push({
          tool_call_id: part.callId,
          role: 'tool',
          content: part.content,
        });
        break;

      case 'toolCall':
        log(`  Found tool call: callId=${part.callId}, name=${part.name}`);
        toolCalls.push({
          id: part.callId,
          type: 'function',
          function: {
            name: part.name,
            arguments: JSON.stringify(part.input),
          },
        });
        break;

      case 'image':
        if (!options.enableImageInput) {
          log(
            `  Skipping data part: mimeType=${part.mimeType}, size=${part.data.length} bytes. (Please enable github.copilot.llm-gateway.enableImageInput in settings)`
          );
          break;
        }
        if (part.mimeType.startsWith('image/')) {
          const url = encodeImageAsDataUrl(part);
          userContent.push({ type: 'image_url', image_url: { url } });
          log(
            `  Added image data part as base64 URL: mimeType=${part.mimeType}, size=${part.data.length} bytes, urlLength=${url.length}`
          );
        }
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

  const result: OpenAIMessage[] = [];
  if (toolCalls.length > 0) {
    result.push({ role: 'assistant', content: textContent || null, tool_calls: toolCalls });
  } else if (toolResults.length > 0) {
    result.push(...toolResults);
  } else if (userContent.length > 0) {
    result.push({ role: message.role, content: userContent });
  } else if (textContent) {
    result.push({ role: message.role, content: textContent });
  }
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
