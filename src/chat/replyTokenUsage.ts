/**
 * Tracks server-reported token usage across the internal tool-call rounds of
 * ONE Copilot reply, so a final summary line can show input/output/total
 * tokens for that reply instead of Copilot's native credits footer.
 *
 * VS Code's stable `LanguageModelChatProvider` API gives each round its own
 * `handle()` call with no public reply/turn identifier — see
 * `/memories/session/plan.md` for the full compatibility analysis. Rounds are
 * linked using two fields the installed Copilot Chat build passes through
 * `options.modelOptions` (`_conversationId`, `_telemetryTurn`); these are
 * private and unstable. Callers MUST fail closed: if either field is absent
 * or malformed, treat the reply as unidentifiable rather than guess.
 *
 * This module is pure (no `vscode` import) so it can be unit-tested with
 * plain data and reused unchanged if the identity source ever changes.
 */

import { OpenAIMessage } from '../api/types';

export interface ReplyIdentity {
  readonly conversationId: string;
  readonly turnIndex: number;
}

/**
 * Validate and extract a {@link ReplyIdentity} from a chat request's
 * `modelOptions`. Returns `undefined` (never a best-guess identity) when
 * either field is missing or the wrong shape — the caller must not track
 * usage for that round.
 */
export function extractReplyIdentity(
  modelOptions: Readonly<Record<string, unknown>> | undefined
): ReplyIdentity | undefined {
  if (!modelOptions) { return undefined; }
  const conversationId = modelOptions._conversationId;
  const turnIndex = modelOptions._telemetryTurn;
  if (typeof conversationId !== 'string' || conversationId.length === 0) { return undefined; }
  if (typeof turnIndex !== 'number' || !Number.isSafeInteger(turnIndex) || turnIndex < 0) {
    return undefined;
  }
  return { conversationId, turnIndex };
}

/** Tool-result `tool_call_id`s a round's outgoing request answers. */
export function extractToolResultIds(messages: readonly OpenAIMessage[]): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    if (msg.role === 'tool' && typeof msg.tool_call_id === 'string') {
      ids.push(msg.tool_call_id);
    }
  }
  return ids;
}

/**
 * One round's server-reported usage, plus whether each field was actually
 * present on the wire (as opposed to defaulted to 0 by normalization). A
 * known zero is valid data; an absent field is unknown.
 */
export interface RoundUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly promptKnown: boolean;
  readonly completionKnown: boolean;
}

export interface RoundOutcome {
  /** Usage the server reported this round, or `undefined` if no usage frame arrived at all. */
  readonly usage?: RoundUsage;
  /** Tool-call IDs the model emitted this round; empty on a terminal (final-answer) round. */
  readonly outgoingToolCallIds: readonly string[];
}

export type ReplyTokenSummary =
  | { readonly kind: 'complete'; readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number }
  | { readonly kind: 'partial'; readonly promptTokens: number; readonly completionTokens: number; readonly totalTokens: number }
  | { readonly kind: 'unavailable' };

interface ChainState {
  promptTokens: number;
  completionTokens: number;
  hadAnyUsage: boolean;
  hadMissingUsage: boolean;
  pendingToolCallIds: ReadonlySet<string>;
  inFlight: number;
  touch: number;
}

const DEFAULT_MAX_INACTIVE_CHAINS = 128;

function sanitize(n: number): number {
  if (!Number.isFinite(n) || n < 0) { return 0; }
  return Math.floor(n);
}

function chainKey(identity: ReplyIdentity): string {
  return `${identity.conversationId}\u0000${identity.turnIndex}`;
}

function emptyChain(): ChainState {
  return {
    promptTokens: 0,
    completionTokens: 0,
    hadAnyUsage: false,
    hadMissingUsage: false,
    pendingToolCallIds: new Set(),
    inFlight: 0,
    touch: 0,
  };
}

/**
 * Accumulates usage across the rounds of replies identified by
 * {@link ReplyIdentity}. One instance is owned by `ChatRequestHandler` for
 * its whole lifetime; state per reply is bounded and cleared on completion,
 * never persisted.
 */
export class ReplyTokenUsageTracker {
  private readonly chains = new Map<string, ChainState>();
  private touchCounter = 0;

  constructor(private readonly maxInactiveChains: number = DEFAULT_MAX_INACTIVE_CHAINS) {}

  /**
   * Register that a round is starting. `incomingToolResultIds` are the
   * `tool_call_id`s this round's outgoing request answers — used to confirm
   * this is really a continuation of the reply's own previous round (rather
   * than an identity coincidentally reused by something else, e.g. a
   * subagent), which starts a fresh chain instead of merging into it.
   */
  beginRound(identity: ReplyIdentity, incomingToolResultIds: readonly string[]): void {
    const key = chainKey(identity);
    const existing = this.chains.get(key);
    const isContinuation =
      existing !== undefined &&
      existing.pendingToolCallIds.size > 0 &&
      incomingToolResultIds.some((id) => existing.pendingToolCallIds.has(id));
    const chain = isContinuation && existing ? existing : emptyChain();
    chain.inFlight++;
    chain.touch = ++this.touchCounter;
    this.chains.set(key, chain);
    this.evictIfNeeded();
  }

  /** Record a round's outcome. No-ops if `beginRound` was never called for this identity. */
  recordRound(identity: ReplyIdentity, outcome: RoundOutcome): void {
    const chain = this.chains.get(chainKey(identity));
    if (!chain) { return; }

    chain.inFlight = Math.max(0, chain.inFlight - 1);

    const promptKnown = outcome.usage?.promptKnown ?? false;
    const completionKnown = outcome.usage?.completionKnown ?? false;
    if (promptKnown) { chain.promptTokens += sanitize(outcome.usage!.promptTokens); }
    if (completionKnown) { chain.completionTokens += sanitize(outcome.usage!.completionTokens); }
    chain.hadAnyUsage = chain.hadAnyUsage || promptKnown || completionKnown;
    chain.hadMissingUsage = chain.hadMissingUsage || !(promptKnown && completionKnown);
    chain.pendingToolCallIds = new Set(outcome.outgoingToolCallIds);
    chain.touch = ++this.touchCounter;
  }

  /** Read the reply's current accumulated totals without clearing state. */
  summarize(identity: ReplyIdentity): ReplyTokenSummary {
    const chain = this.chains.get(chainKey(identity));
    if (!chain || !chain.hadAnyUsage) { return { kind: 'unavailable' }; }
    const totalTokens = chain.promptTokens + chain.completionTokens;
    return chain.hadMissingUsage
      ? { kind: 'partial', promptTokens: chain.promptTokens, completionTokens: chain.completionTokens, totalTokens }
      : { kind: 'complete', promptTokens: chain.promptTokens, completionTokens: chain.completionTokens, totalTokens };
  }

  /** Clear a reply's state. Call once its terminal (tool-call-free) round completes. */
  finish(identity: ReplyIdentity): void {
    this.chains.delete(chainKey(identity));
  }

  /** Number of tracked chains (test/diagnostic use only). */
  get size(): number {
    return this.chains.size;
  }

  private evictIfNeeded(): void {
    if (this.chains.size <= this.maxInactiveChains) { return; }
    const evictable = [...this.chains.entries()]
      .filter(([, chain]) => chain.inFlight === 0)
      .sort((a, b) => a[1].touch - b[1].touch);
    for (const [key] of evictable) {
      if (this.chains.size <= this.maxInactiveChains) { break; }
      this.chains.delete(key);
    }
  }
}

function formatWithCommas(n: number): string {
  return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/** Render the final-line summary text for a reply's accumulated usage. */
export function formatReplyTokenSummaryLine(summary: ReplyTokenSummary): string {
  if (summary.kind === 'unavailable') {
    return 'Tokens: input unavailable | output unavailable | total unavailable';
  }
  const label = summary.kind === 'partial' ? 'Tokens (partial)' : 'Tokens';
  return (
    `${label}: input ${formatWithCommas(summary.promptTokens)} | ` +
    `output ${formatWithCommas(summary.completionTokens)} | ` +
    `total ${formatWithCommas(summary.totalTokens)}`
  );
}
