/**
 * Token accounting utilities.
 *
 * Token estimates are rough — the LLM gateway uses a char/4 approximation
 * rather than a real tokenizer. That's fine for budget math (we mostly care
 * about detecting context overflow), but any single count may be off by ~25%.
 */

export const TOKEN_CONSTANTS = {
  DEFAULT_CONTEXT_TOKENS: 262144,
  DEFAULT_OUTPUT_TOKENS: 2048,
  FALLBACK_OUTPUT_TOKENS: 4096,
  MIN_OUTPUT_TOKENS: 64,
  CONTEXT_BUFFER_TOKENS: 256,
  ADJUST_TOKEN_BUFFER: 256,
  INPUT_OVERHEAD_RATIO: 1.2,
  CHARS_PER_TOKEN: 4,
} as const;

export type TokenLogger = (message: string) => void;

const NOOP_LOGGER: TokenLogger = () => {
  /* no-op */
};

/**
 * Minimal message shape needed for token estimation. Intentionally structural
 * so callers can pass OpenAI wire-format messages without a type cast.
 */
export interface TokenEstimableMessage {
  content?: string | object | null;
  tool_calls?: unknown;
}

/**
 * Estimate token count for a text string using the CHARS_PER_TOKEN ratio.
 */
export function estimateTextTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CONSTANTS.CHARS_PER_TOKEN);
}

/**
 * Estimate tokens for an OpenAI-format message, including tool_calls if present.
 */
export function estimateMessageTokens(message: TokenEstimableMessage): number {
  let text = '';
  if (typeof message.content === 'string') {
    text = message.content;
  } else if (message.content) {
    text = JSON.stringify(message.content);
  }
  if (message.tool_calls) {
    text += JSON.stringify(message.tool_calls);
  }
  return estimateTextTokens(text);
}

/**
 * Concatenate all message text into a single string, mirroring what we'd send
 * on the wire. Used as input to {@link estimateTextTokens}.
 */
export function buildInputText(messages: readonly TokenEstimableMessage[]): string {
  return messages
    .map((m) => {
      let text = typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? '');
      if (m.tool_calls) {
        text += JSON.stringify(m.tool_calls);
      }
      return text;
    })
    .join('\n');
}

/**
 * Truncate messages to fit within `maxTokens`.
 *
 * Strategy: always keep the first message (typically the system prompt) and
 * as many trailing messages as will fit, working backwards from the end.
 * Mid-conversation messages are dropped first.
 */
export function truncateMessagesToFit<T extends TokenEstimableMessage>(
  messages: readonly T[],
  maxTokens: number,
  log: TokenLogger = NOOP_LOGGER
): T[] {
  if (messages.length === 0) {
    return [];
  }

  let totalTokens = 0;
  const messageTokens: number[] = [];
  for (const msg of messages) {
    const tokens = estimateMessageTokens(msg);
    messageTokens.push(tokens);
    totalTokens += tokens;
  }

  if (totalTokens <= maxTokens) {
    return [...messages];
  }

  log(`Context overflow: ${totalTokens} tokens > ${maxTokens} limit. Truncating...`);

  const result: T[] = [messages[0]];
  let usedTokens = messageTokens[0];

  const recentMessages: T[] = [];
  for (let i = messages.length - 1; i > 0; i--) {
    const msgTokens = messageTokens[i];
    if (usedTokens + msgTokens <= maxTokens) {
      recentMessages.unshift(messages[i]);
      usedTokens += msgTokens;
    } else {
      break;
    }
  }

  result.push(...recentMessages);
  log(`Truncated: kept ${result.length}/${messages.length} messages, ~${usedTokens} tokens`);
  return result;
}

export interface SafeOutputTokensParams {
  estimatedInputTokens: number;
  toolsOverhead: number;
  modelMaxContext: number;
  configuredMaxOutput: number;
}

/**
 * Given an input-token estimate, decide how many output tokens we can safely
 * request without tripping context-length errors. Adds INPUT_OVERHEAD_RATIO
 * slack to account for tokenizer drift and a fixed CONTEXT_BUFFER_TOKENS.
 */
export function calculateSafeMaxOutputTokens(params: SafeOutputTokensParams): number {
  const totalEstimatedTokens = params.estimatedInputTokens + params.toolsOverhead;
  const conservativeInputEstimate = Math.ceil(
    totalEstimatedTokens * TOKEN_CONSTANTS.INPUT_OVERHEAD_RATIO
  );

  const safeMaxOutputTokens = Math.min(
    params.configuredMaxOutput,
    Math.floor(params.modelMaxContext - conservativeInputEstimate - TOKEN_CONSTANTS.CONTEXT_BUFFER_TOKENS)
  );

  return Math.max(TOKEN_CONSTANTS.MIN_OUTPUT_TOKENS, safeMaxOutputTokens);
}

export interface MaxInputTokensParams {
  modelMaxContext: number;
  configuredMaxOutput: number;
  toolsSerializedLength: number;
}

/**
 * Compute the ceiling on input tokens for a request so there's still room
 * for output + tools in the context window.
 */
export function calculateMaxInputTokens(params: MaxInputTokensParams): number {
  const desiredOutputTokens = Math.min(
    params.configuredMaxOutput,
    Math.floor(params.modelMaxContext / 2)
  );
  const toolsTokenEstimate = Math.ceil(
    (params.toolsSerializedLength / TOKEN_CONSTANTS.CHARS_PER_TOKEN) *
      TOKEN_CONSTANTS.INPUT_OVERHEAD_RATIO
  );
  return params.modelMaxContext - desiredOutputTokens - toolsTokenEstimate - TOKEN_CONSTANTS.CONTEXT_BUFFER_TOKENS;
}
