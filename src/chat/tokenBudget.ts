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
  role?: string;
  tool_call_id?: string;
  tool_calls?: unknown;
}

function getToolCallIds(message: TokenEstimableMessage): Set<string> {
  const ids = new Set<string>();
  if (message.role !== 'assistant' || !Array.isArray(message.tool_calls)) {
    return ids;
  }
  for (const toolCall of message.tool_calls) {
    if (typeof toolCall === 'object' && toolCall !== null) {
      const id = (toolCall as { id?: unknown }).id;
      if (typeof id === 'string') {
        ids.add(id);
      }
    }
  }
  return ids;
}

function isToolResultFor(message: TokenEstimableMessage, toolCallIds: Set<string>): boolean {
  const toolCallId = message.tool_call_id;
  return message.role === 'tool' && typeof toolCallId === 'string' && toolCallIds.has(toolCallId);
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
 * as many trailing message groups as will fit, working backwards from the end.
 * An assistant tool call and its adjacent results form one group so truncation
 * cannot retain only half of a tool exchange. Mid-conversation groups are
 * dropped first.
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

  const units: Array<{ messages: T[]; tokens: number }> = [];
  for (let i = 1; i < messages.length;) {
    const unitMessages = [messages[i]];
    let unitTokens = messageTokens[i];
    const toolCallIds = getToolCallIds(messages[i]);
    i++;

    while (
      i < messages.length &&
      isToolResultFor(messages[i], toolCallIds)
    ) {
      unitMessages.push(messages[i]);
      unitTokens += messageTokens[i];
      i++;
    }
    units.push({ messages: unitMessages, tokens: unitTokens });
  }

  let usedTokens = messageTokens[0];
  const recentUnits: T[][] = [];
  for (let i = units.length - 1; i >= 0; i--) {
    if (usedTokens + units[i].tokens <= maxTokens) {
      recentUnits.unshift(units[i].messages);
      usedTokens += units[i].tokens;
    } else {
      break;
    }
  }

  const result = [messages[0], ...recentUnits.flat()];
  const retainedToolCallIds = new Set<string>();
  for (const message of result) {
    for (const id of getToolCallIds(message)) {
      retainedToolCallIds.add(id);
    }
  }

  let droppedOrphans = 0;
  const validatedResult = result.filter((message) => {
    const isOrphan =
      message.role === 'tool' &&
      typeof message.tool_call_id === 'string' &&
      !retainedToolCallIds.has(message.tool_call_id);
    if (isOrphan) {
      droppedOrphans++;
      usedTokens -= estimateMessageTokens(message);
    }
    return !isOrphan;
  });
  if (droppedOrphans > 0) {
    log(`Dropped ${droppedOrphans} orphaned tool result message(s) after truncation`);
  }
  log(`Truncated: kept ${validatedResult.length}/${messages.length} messages, ~${usedTokens} tokens`);
  return validatedResult;
}

export interface SafeOutputTokensParams {
  estimatedInputTokens: number;
  toolsOverhead: number;
  modelMaxContext: number;
  configuredMaxOutput: number;
  /**
   * Set when `modelMaxContext` is an input-only ceiling and the model has its
   * own separate completion window (LiteLLM). Output then doesn't compete with
   * the prompt for space. See {@link hasSeparateOutputWindow}.
   */
  outputWindowIsSeparate?: boolean;
}

/**
 * Given an input-token estimate, decide how many output tokens we can safely
 * request without tripping context-length errors. Adds INPUT_OVERHEAD_RATIO
 * slack to account for tokenizer drift and a fixed CONTEXT_BUFFER_TOKENS.
 */
export function calculateSafeMaxOutputTokens(params: SafeOutputTokensParams): number {
  // Two independent windows: the prompt can't crowd out the completion, so the
  // model's own output ceiling is the only bound that applies.
  if (params.outputWindowIsSeparate) {
    return Math.max(TOKEN_CONSTANTS.MIN_OUTPUT_TOKENS, params.configuredMaxOutput);
  }

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
  /** See {@link SafeOutputTokensParams.outputWindowIsSeparate}. */
  outputWindowIsSeparate?: boolean;
}

/**
 * Compute the ceiling on input tokens for a request so there's still room
 * for output + tools in the context window.
 *
 * Must stay the exact inverse of {@link calculateSafeMaxOutputTokens}: that
 * function inflates (input + tools) by INPUT_OVERHEAD_RATIO, so the ceiling
 * here divides the available budget by the same ratio before subtracting the
 * raw tools estimate. If the two drift apart, a conversation can pass the
 * truncation gate yet leave "no room" for output, collapsing max_tokens to
 * MIN_OUTPUT_TOKENS (issue #74).
 */
export function calculateMaxInputTokens(params: MaxInputTokensParams): number {
  // With a separate completion window there is nothing to reserve — carving
  // output out of an input-only ceiling throws away prompt space the server
  // was always willing to accept.
  const desiredOutputTokens = params.outputWindowIsSeparate
    ? 0
    : Math.min(params.configuredMaxOutput, Math.floor(params.modelMaxContext / 2));
  const toolsRawEstimate = Math.ceil(
    params.toolsSerializedLength / TOKEN_CONSTANTS.CHARS_PER_TOKEN
  );
  const inputBudget =
    params.modelMaxContext - desiredOutputTokens - TOKEN_CONSTANTS.CONTEXT_BUFFER_TOKENS;
  return Math.max(
    0,
    Math.floor(inputBudget / TOKEN_CONSTANTS.INPUT_OVERHEAD_RATIO) - toolsRawEstimate
  );
}
