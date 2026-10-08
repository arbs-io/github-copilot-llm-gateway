import * as vscode from 'vscode';
import {
  convertMessage,
  decodeTextData,
  flattenToolResultContent,
  isTextMimeType,
  isThinkingPartShape,
  NormalizedMessage,
  NormalizedPart,
  NormalizedRole,
  normalizeThinkingValue,
} from '../chat/messageConverter';
import { estimateTextTokens, TOKEN_CONSTANTS } from '../chat/tokenBudget';
import { OpenAIMessage } from '../api/types';

type Logger = (message: string) => void;

/**
 * Adapter between VS Code's `LanguageModelChat*` object model and the plain
 * data shapes used by the pure chat modules. Everything vscode-class-specific
 * (instanceof checks, duck typing for older hosts) lives here so the rest of
 * the provider stays testable.
 */

export function convertAllMessages(
  messages: readonly vscode.LanguageModelChatMessage[],
  options: { enableImageInput: boolean; replayReasoning: boolean },
  log: Logger
): OpenAIMessage[] {
  const result: OpenAIMessage[] = [];
  for (const msg of messages) {
    const normalized: NormalizedMessage = {
      role: mapRole(msg.role),
      parts: msg.content.map((part) => classifyPart(part, log)),
    };
    result.push(...convertMessage(normalized, options, log));
  }
  return result;
}

export function mapRole(role: vscode.LanguageModelChatMessageRole): NormalizedRole {
  if (role === vscode.LanguageModelChatMessageRole.Assistant) {
    return 'assistant';
  }
  return 'user';
}

/**
 * Translate a vscode LanguageModel*Part into the plain data shape used by
 * messageConverter. Falls back to duck typing for older VS Code versions
 * where the constructors may not match.
 */
export function classifyPart(part: unknown, log: Logger): NormalizedPart {
  if (part instanceof vscode.LanguageModelTextPart) {
    return { kind: 'text', value: part.value };
  }
  if (part instanceof vscode.LanguageModelToolResultPart) {
    return {
      kind: 'toolResult',
      callId: part.callId,
      content: flattenToolResultContent(part.content),
    };
  }
  if (part instanceof vscode.LanguageModelToolCallPart) {
    return {
      kind: 'toolCall',
      callId: part.callId,
      name: part.name,
      input: part.input,
    };
  }
  if (part instanceof vscode.LanguageModelDataPart) {
    return { kind: 'image', mimeType: part.mimeType, data: part.data };
  }
  const thinking = readThinkingText(part);
  if (thinking !== undefined) {
    return { kind: 'thinking', value: thinking };
  }
  return classifyPartDuckTyped(part, log);
}

/**
 * Text of a `LanguageModelThinkingPart`, or `undefined` for any other part.
 * The class is proposed API, so guard the constructor before `instanceof`
 * and fall back to its shape. `value` may be `string | string[]`.
 */
function readThinkingText(part: unknown): string | undefined {
  const ctor: unknown = vscode.LanguageModelThinkingPart;
  const isInstance = typeof ctor === 'function' && part instanceof ctor;
  if (!isInstance && !isThinkingPartShape(part)) {
    return undefined;
  }
  return normalizeThinkingValue((part as { value?: unknown }).value);
}

function classifyPartDuckTyped(part: unknown, log: Logger): NormalizedPart {
  if (typeof part !== 'object' || part === null) {
    return { kind: 'unknown' };
  }
  const anyPart = part as Record<string, unknown>;

  if ('callId' in anyPart && 'content' in anyPart && !('name' in anyPart)) {
    log(`  Found tool result (duck-typed): callId=${anyPart.callId}`);
    return {
      kind: 'toolResult',
      callId: String(anyPart.callId),
      content: flattenToolResultContent(anyPart.content),
    };
  }
  if ('callId' in anyPart && 'name' in anyPart && 'input' in anyPart) {
    log(`  Found tool call (duck-typed): callId=${anyPart.callId}, name=${anyPart.name}`);
    return {
      kind: 'toolCall',
      callId: String(anyPart.callId),
      name: String(anyPart.name),
      input: anyPart.input,
    };
  }
  if (typeof anyPart.mimeType === 'string' && anyPart.data instanceof Uint8Array) {
    log(`  Found data part (duck-typed): mimeType=${anyPart.mimeType}`);
    return { kind: 'image', mimeType: anyPart.mimeType, data: anyPart.data };
  }
  return { kind: 'unknown' };
}

/**
 * Rough token estimate for a full chat message (char/4 approximation).
 *
 * Non-text parts contribute too: tool calls / tool results are serialized
 * and counted, and each image contributes a conservative fixed overhead so
 * we don't undercount multimodal conversations (otherwise the output-token
 * budget overshoots the real context window). Thinking parts count only when
 * `replayReasoning` is on, since only then are they sent to the server.
 */
export function countMessageTokens(
  message: vscode.LanguageModelChatMessage,
  replayReasoning = false
): number {
  // Mirror the converter: only assistant messages replay their thinking.
  const countThinking =
    replayReasoning && message.role === vscode.LanguageModelChatMessageRole.Assistant;
  let tokens = 0;
  for (const part of message.content) {
    if (part instanceof vscode.LanguageModelTextPart) {
      tokens += estimateTextTokens(part.value);
    } else if (part instanceof vscode.LanguageModelToolCallPart) {
      tokens += estimateTextTokens(part.name + JSON.stringify(part.input ?? {}));
    } else if (part instanceof vscode.LanguageModelToolResultPart) {
      const body = flattenToolResultContent(part.content);
      tokens += estimateTextTokens(body);
    } else if (part instanceof vscode.LanguageModelDataPart && isTextMimeType(part.mimeType)) {
      tokens += estimateTextTokens(decodeTextData(part.data));
    } else if (part instanceof vscode.LanguageModelDataPart) {
      // Images don't map cleanly to tokens — reserve a conservative fixed
      // overhead so multimodal requests aren't massively undercounted.
      tokens += TOKEN_CONSTANTS.IMAGE_INPUT_TOKENS;
    } else if (countThinking) {
      tokens += estimateTextTokens(readThinkingText(part) ?? '');
    }
  }
  return tokens;
}
