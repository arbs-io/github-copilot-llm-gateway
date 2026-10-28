/**
 * Stream processor for OpenAI-compatible SSE chat completion chunks.
 *
 * Owns the ThinkingParser and the book-keeping around `reasoning_content`
 * fields, `<thinking>` tags, and force-closed thinking blocks. Reports
 * results through a {@link StreamReporter} interface rather than talking
 * to VS Code directly, so it can be exercised by unit tests with a fake
 * reporter.
 */

import { ThinkingParser, ThinkingChunk } from './thinking';
import { RepetitionDetector } from './repetitionDetector';
import { OpenAIUsage, OpenAIUsageAvailability } from '../api/types';

export interface StreamReporter {
  reportText(text: string): void;
  reportThinking(text: string): void;
  reportThinkingDone(): void;
  reportToolCall(id: string, name: string, args: Record<string, unknown>): void;
  /**
   * Report a usage frame from the inference server. Called at most once per
   * stream — the OpenAI convention is to emit a trailing chunk with totals
   * after the last delta. Wired to VS Code's chat context-window widget via
   * a `LanguageModelDataPart` (issue #24). `availability` records which
   * fields were actually present on the wire, for consumers (the per-reply
   * token summary) that must distinguish a reported zero from an absent
   * field.
   */
  reportUsage(usage: OpenAIUsage, availability?: OpenAIUsageAvailability): void;
}

export interface StreamChunk {
  content?: string;
  reasoning_content?: string;
  finished_tool_calls?: Array<{ id: string; name: string; arguments: string }>;
  usage?: OpenAIUsage;
  usageAvailability?: OpenAIUsageAvailability;
  /** Server `finish_reason` for this chunk, when set (see `GatewayStreamChunk`). */
  finish_reason?: string;
}

export interface StreamStats {
  /** Number of content characters observed across all chunks. */
  totalContentLength: number;
  totalToolCalls: number;
  totalTextParts: number;
  hadThinking: boolean;
  thinkingForceClosed: boolean;
  /** Last `finish_reason` the server sent, if any (`stop`, `length`, `tool_calls`, …). */
  finishReason?: string;
  /**
   * True when the server reported `finish_reason: length` and the stream
   * carried no visible text or tool calls — the model spent its whole
   * `max_tokens` budget (typically on `reasoning_content`) before it could
   * answer. `streamResponse` emits its own explanatory fallback for this, so
   * `isEmptyStreamResult` treats it as handled, like `thinkingForceClosed`.
   */
  outputTruncated?: boolean;
  /**
   * True when the model stopped on its own after thinking but never wrote a
   * reply or called a tool (issue #136: Qwen3 via llama-server sometimes puts
   * its closing summary inside the think block). Handled with its own note.
   */
  endedInThinking?: boolean;
  /** True when the loop guard cut the stream because the output became a repeating cycle. */
  repetitionStopped?: boolean;
  /** Tool calls withheld by `withholdToolCall` (the loop guard's blocked repeat). */
  droppedToolCalls?: number;
  /**
   * True once a usage frame has been dispatched to the reporter. Internal
   * book-keeping to dedupe re-emitted totals from chatty servers; optional
   * so callers constructing `StreamStats` for `isEmptyStreamResult` checks
   * don't need to pass it.
   */
  reportedUsage?: boolean;
}

export interface StreamResponseParams {
  chunks: AsyncIterable<StreamChunk>;
  reporter: StreamReporter;
  /** Called before reading each chunk; return true to stop early. */
  isCancelled: () => boolean;
  /**
   * Called with each finished tool call. The callback is responsible for
   * JSON-repairing the arguments and filling any missing required properties
   * from the tool's schema.
   */
  resolveToolCallArgs: (toolCall: { id: string; name: string; arguments: string }) => Record<string, unknown>;
  /**
   * The `max_tokens` sent with the request, quoted in the fallback text when
   * the model exhausts it without producing an answer.
   */
  maxOutputTokens?: number;
  /** Stop the stream once text or thinking degenerates into a repeating cycle. */
  detectRepetition?: boolean;
  /** Return true to withhold a tool call (after argument repair) instead of reporting it. */
  withholdToolCall?: (name: string, args: Record<string, unknown>) => boolean;
}

const REPETITION_STOP_NOTE =
  '\n\n*(Stopped: the model kept repeating the same output, so the response was cut off. ' +
  'Ask it to continue or rephrase the request. Turn this off with ' +
  '`github.copilot.llm-gateway.loopGuardRepetition`.)*';

const BLOCKED_TOOL_CALL_NOTE =
  '*(Loop guard: the model made the blocked tool call again instead of changing approach, so this reply ends here. ' +
  'Send a follow-up with a hint on how to proceed, or adjust `github.copilot.llm-gateway.loopGuardToolBlockAfter`.)*';

const ENDED_IN_THINKING_NOTE =
  '*(The model stopped while still thinking and didn\'t write a reply. Its last thoughts are in the thinking block above. ' +
  'This comes from the model rather than the gateway; heavily quantized models and a temperature of 0 make it more likely. ' +
  'Send a follow-up to get an answer, or set the model\'s recommended sampling in `github.copilot.llm-gateway.perModelOptions`.)*';

const THOUSANDS_FORMAT = new Intl.NumberFormat('en-US', { useGrouping: true });

/**
 * Explain an empty reply caused by the output budget running out. Thinking
 * models (Qwen3, DeepSeek-R1, …) routinely burn several thousand tokens of
 * `reasoning_content` on a modest coding request, so a small `max_tokens`
 * ends the stream before any answer text exists — which otherwise surfaces
 * as a generic "empty response" diagnostic that blames tool calling.
 */
function buildOutputBudgetFallback(hadThinking: boolean, maxOutputTokens: number | undefined): string {
  const budget = maxOutputTokens === undefined ? 'output-token' : `${THOUSANDS_FORMAT.format(maxOutputTokens)}-token output`;
  const spentOn = hadThinking ? 'on thinking' : 'before producing any answer';
  return (
    `*(The model used its whole ${budget} budget ${spentOn} and produced no response. ` +
    'Raise `github.copilot.llm-gateway.defaultMaxOutputTokens`' +
    (hadThinking ? ', lower the model\'s thinking effort (GitHub Copilot LLM Gateway: Set Thinking Effort), ' : ' ') +
    'or check the server\'s own max output limit.)*'
  );
}

/**
 * Dispatch a single ThinkingParser piece to the reporter, updating stats.
 *
 * `allowForceClose` is true only when flushing the parser at end-of-stream —
 * an 'E' piece mid-stream is just a normal end-of-thinking marker, while an
 * 'E' piece at flush time indicates the stream truncated mid-think block.
 */
function reportParserPiece(
  piece: ThinkingChunk,
  reporter: StreamReporter,
  stats: StreamStats,
  allowForceClose: boolean
): void {
  if (piece.t === 'T') {
    stats.hadThinking = true;
    reporter.reportThinking(piece.c);
    return;
  }
  if (piece.t === 'E') {
    if (allowForceClose) {
      stats.thinkingForceClosed = true;
    }
    reporter.reportThinkingDone();
    return;
  }
  if (piece.c) {
    stats.totalTextParts++;
    reporter.reportText(piece.c);
  }
}

/**
 * Process a single stream chunk, updating stats and dispatching events
 * through the reporter.
 * @returns updated inReasoningField flag.
 */
function processStreamChunk(
  chunk: StreamChunk,
  parser: ThinkingParser,
  stats: StreamStats,
  inReasoningField: boolean,
  params: StreamResponseParams
): boolean {
  const { reporter } = params;
  if (chunk.reasoning_content) {
    stats.hadThinking = true;
    inReasoningField = true;
    reporter.reportThinking(chunk.reasoning_content);
  }

  if (chunk.content) {
    if (inReasoningField) {
      inReasoningField = false;
      reporter.reportThinkingDone();
    }
    stats.totalContentLength += chunk.content.length;
    for (const piece of parser.process(chunk.content)) {
      reportParserPiece(piece, reporter, stats, false);
    }
  }

  if (chunk.finished_tool_calls?.length) {
    reportToolCalls(chunk.finished_tool_calls, stats, params);
  }

  if (chunk.finish_reason) {
    stats.finishReason = chunk.finish_reason;
  }

  if (chunk.usage && !stats.reportedUsage) {
    // Latch on the first usage frame; some servers re-emit the same totals
    // across the trailing few chunks. Reporting twice would briefly double
    // VS Code's running context-window count before settling.
    stats.reportedUsage = true;
    reporter.reportUsage(chunk.usage, chunk.usageAvailability);
  }

  return inReasoningField;
}

function reportToolCalls(
  toolCalls: NonNullable<StreamChunk['finished_tool_calls']>,
  stats: StreamStats,
  params: StreamResponseParams
): void {
  for (const toolCall of toolCalls) {
    const args = params.resolveToolCallArgs(toolCall);
    if (params.withholdToolCall?.(toolCall.name, args)) {
      stats.droppedToolCalls = (stats.droppedToolCalls ?? 0) + 1;
      continue;
    }
    stats.totalToolCalls++;
    params.reporter.reportToolCall(toolCall.id, toolCall.name, args);
  }
}

function streamedText(chunk: StreamChunk): string {
  return (chunk.reasoning_content ?? '') + (chunk.content ?? '');
}

/** Emit the note that explains a stopped or empty reply, when one is needed. */
function reportStreamEnd(stats: StreamStats, params: StreamResponseParams): void {
  const { reporter } = params;
  // A mid-<think> stop sets thinkingForceClosed; the budget note would misreport it.
  if (stats.repetitionStopped) {
    reporter.reportText(REPETITION_STOP_NOTE);
    return;
  }
  if (params.isCancelled()) {
    return;
  }

  // A withheld repeat with no other call ends the agent turn, which needs explaining even after some text.
  if (stats.droppedToolCalls && stats.totalToolCalls === 0) {
    reporter.reportText(stats.totalTextParts === 0 ? BLOCKED_TOOL_CALL_NOTE : `\n\n${BLOCKED_TOOL_CALL_NOTE}`);
    return;
  }
  if (stats.totalTextParts > 0 || stats.totalToolCalls > 0) {
    return;
  }

  // If the model spent all its output budget before producing any visible
  // text or tool calls, emit a fallback message so the Copilot Chat UI has
  // something to render. Two signals: an unclosed `<think>` block at
  // end-of-stream (servers that inline thinking in `content`), or an explicit
  // `finish_reason: length` (servers that split it into `reasoning_content`,
  // where the parser never sees a tag to force-close).
  stats.outputTruncated = stats.finishReason === 'length';
  if (stats.thinkingForceClosed || stats.outputTruncated) {
    reporter.reportText(buildOutputBudgetFallback(stats.hadThinking, params.maxOutputTokens));
    return;
  }

  // Thinking the model ended on purpose, with nothing after it, is a finished
  // turn rather than a failed one, so it gets a note instead of the
  // empty-response error. No finish_reason could be a dropped stream; leave that alone.
  if (stats.hadThinking && stats.finishReason === 'stop') {
    stats.endedInThinking = true;
    reporter.reportText(ENDED_IN_THINKING_NOTE);
  }
}

/**
 * Consume an async stream of chat completion chunks, dispatching pieces to
 * the reporter as they arrive. Returns aggregate stats that the caller can
 * use to decide whether the response was empty and needs an error fallback.
 */
export async function streamResponse(params: StreamResponseParams): Promise<StreamStats> {
  const { chunks, reporter, isCancelled } = params;

  const stats: StreamStats = {
    totalContentLength: 0,
    totalToolCalls: 0,
    totalTextParts: 0,
    hadThinking: false,
    thinkingForceClosed: false,
    reportedUsage: false,
  };

  const parser = new ThinkingParser();
  const detector = params.detectRepetition ? new RepetitionDetector() : undefined;
  let inReasoningField = false;

  for await (const chunk of chunks) {
    if (isCancelled()) {
      break;
    }
    inReasoningField = processStreamChunk(chunk, parser, stats, inReasoningField, params);
    if (detector?.push(streamedText(chunk))) {
      stats.repetitionStopped = true;
      break;
    }
  }

  // Flush any remaining buffered content. 'E' pieces here signal that the
  // stream ended mid-think block.
  for (const piece of parser.flush()) {
    reportParserPiece(piece, reporter, stats, true);
  }

  if (inReasoningField) {
    reporter.reportThinkingDone();
  }

  reportStreamEnd(stats, params);
  return stats;
}

/**
 * Determine whether a completed stream should be treated as empty (and thus
 * needs an error fallback message). Thinking content is not a visible response
 * for VS Code's purposes. Force-closed thinking, an exhausted output budget,
 * a reply that ended in thinking and a loop-guard stop are excluded because streamResponse already emits its
 * dedicated fallback text for them.
 */
export function isEmptyStreamResult(stats: StreamStats): boolean {
  return (
    stats.totalTextParts === 0 &&
    stats.totalToolCalls === 0 &&
    !stats.thinkingForceClosed &&
    !stats.outputTruncated &&
    !stats.endedInThinking &&
    !stats.repetitionStopped &&
    !stats.droppedToolCalls
  );
}
