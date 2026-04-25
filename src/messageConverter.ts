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

import { OpenAIMessage } from './types';

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
