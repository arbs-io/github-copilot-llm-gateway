import { OpenAIMessage } from '../api/types';
import { repairJsonObject } from '../chat/toolArguments';
import { inferNextToolFamilies, inferToolFamily, summarizeToolResult } from './toolMetadata';
import {
  ProgressEvaluation,
  ProgressPolicy,
  ProgressEscalationStage,
  ToolFamily,
  ToolFamilyProgressThresholds,
} from './types';

interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface ProgressState {
  turns: number;
  noProgressTurns: number;
  repeatedCalls: number;
  repeatedFamilies: number;
  lowSignalResults: number;
  productiveResults: number;
  visibleProgress: number;
  transitions: number;
  novelty: number;
  lastName?: string;
  lastSignature?: string;
  lastFamily?: ToolFamily;
  lastResultSummary?: string;
  activeFamily?: ToolFamily;
  namesById: Map<string, string>;
  signaturesById: Map<string, string>;
  productiveSignatures: Set<string>;
}

export interface CandidateToolProgressInput {
  name: string;
  arguments: string;
  id?: string;
}

export const DEFAULT_PROGRESS_POLICY: ProgressPolicy = {
  exactRepeatedToolCallLimit: 4,
  groundedAssistantCharacters: 200,
  toolResultSummaryCharacters: 400,
  toolFamilyProgress: {
    memory: thresholds(60, 2, 4, 6, 8, 3),
    completion: thresholds(32, 1, 2, 3, 4, 2),
    editing: thresholds(40, 3, 5, 7, 10, 4),
    discovery: thresholds(80, 4, 6, 8, 12, 4),
    execution: thresholds(56, 2, 4, 6, 8, 3),
    network: thresholds(80, 3, 5, 7, 10, 3),
    other: thresholds(80, 2, 4, 6, 8, 3),
  },
};

export function evaluateTranscriptProgress(
  messages: readonly OpenAIMessage[],
  policy: ProgressPolicy = DEFAULT_PROGRESS_POLICY
): ProgressEvaluation {
  return buildEvaluation(extractState(messages, policy), policy, false);
}

export function evaluateCandidateToolProgress(
  messages: readonly OpenAIMessage[],
  policy: ProgressPolicy,
  candidate: CandidateToolProgressInput
): ProgressEvaluation {
  return evaluateCandidateToolBatchProgress(messages, policy, [candidate]);
}

/**
 * Evaluate parallel calls as one assistant turn. This prevents a legitimate
 * N-call batch from consuming N loop turns while still detecting an exact
 * repeated batch signature.
 */
export function evaluateCandidateToolBatchProgress(
  messages: readonly OpenAIMessage[],
  policy: ProgressPolicy,
  candidates: readonly CandidateToolProgressInput[],
  assistantContentCharacters = 0
): ProgressEvaluation {
  const state = extractState(messages, policy);
  applyToolBatch(
    state,
    candidates.map((candidate, index) => ({
      id: candidate.id ?? `candidate_${index}`,
      name: candidate.name,
      arguments: candidate.arguments,
    })),
    assistantContentCharacters,
    policy
  );
  return buildEvaluation(state, policy, true);
}

export function buildReplanInstruction(progress: ProgressEvaluation): string {
  const family = progress.activeFamily ?? 'other';
  const reason = progress.reasons[0] ?? 'The current tool sequence is not making grounded progress.';
  return `Replan before using more tools. The current ${family} phase is drifting. ${reason} Summarize what you learned, name the single next highest-value step, and avoid repeating a tool family without new evidence.`;
}

export function buildForcedSummaryInstruction(progress: ProgressEvaluation): string {
  const reason = progress.reasons[0] ?? 'The current tool sequence is not making enough progress.';
  return `Do not call tools in this response. Provide a grounded summary of what you learned, what is still missing, and the single next human step. ${reason}`;
}

function extractState(messages: readonly OpenAIMessage[], policy: ProgressPolicy): ProgressState {
  const state = emptyState();
  for (const message of messages) {
    if (isGroundedAssistant(message, policy.groundedAssistantCharacters)) {
      reset(state);
      continue;
    }
    const calls = getToolCalls(message);
    if (calls.length > 0) {
      applyToolBatch(state, calls, extractText(message.content).trim().length, policy);
      for (const call of calls) {
        state.namesById.set(call.id, call.name);
        state.signaturesById.set(call.id, callSignature(call));
      }
      continue;
    }
    if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      applyToolResult(state, message.tool_call_id, extractText(message.content), policy);
    }
  }
  return state;
}

function applyToolBatch(
  state: ProgressState,
  calls: readonly ToolCall[],
  assistantCharacters: number,
  policy: ProgressPolicy
): void {
  if (calls.length === 0) { return; }
  const family = batchFamily(calls);
  const name = calls.map((call) => call.name).join(', ');
  const signature = batchSignature(calls);
  const noProgress = assistantCharacters < policy.toolFamilyProgress[family].assistantCharacters;

  state.turns++;
  state.activeFamily = family;
  if (state.lastFamily && state.lastFamily !== family) { state.transitions++; }
  if (state.lastName && state.lastName !== name) { state.novelty++; }

  if (noProgress) {
    state.noProgressTurns++;
    state.repeatedCalls = signature === state.lastSignature ? state.repeatedCalls + 1 : 1;
    state.repeatedFamilies = family === state.lastFamily ? state.repeatedFamilies + 1 : 1;
  } else {
    state.noProgressTurns = 0;
    state.repeatedCalls = 1;
    state.repeatedFamilies = 1;
  }
  state.lastSignature = signature;
  state.lastFamily = family;
  state.lastName = name;
}

function applyToolResult(
  state: ProgressState,
  callId: string,
  content: string,
  policy: ProgressPolicy
): void {
  const name = state.namesById.get(callId);
  const signature = state.signaturesById.get(callId);
  if (!name) { return; }
  const digest = summarizeToolResult(name, content, policy.toolResultSummaryCharacters);
  if (digest.indicatesVisibleProgress) { state.visibleProgress++; }
  if (digest.quality === 'useful' && signature && !state.productiveSignatures.has(signature)) {
    state.productiveSignatures.add(signature);
    state.productiveResults++;
    state.noProgressTurns = Math.max(0, state.noProgressTurns - 1);
    state.repeatedFamilies = Math.max(1, state.repeatedFamilies - 1);
    state.lowSignalResults = 0;
  } else if (digest.quality !== 'useful') {
    state.lowSignalResults =
      digest.summary === state.lastResultSummary ? state.lowSignalResults + 1 : Math.max(1, state.lowSignalResults);
  }
  state.lastResultSummary = digest.summary;
}

function buildEvaluation(
  state: ProgressState,
  policy: ProgressPolicy,
  candidate: boolean
): ProgressEvaluation {
  const family = state.activeFamily ?? state.lastFamily ?? 'other';
  const limit = policy.toolFamilyProgress[family];
  const reasons: string[] = [];
  if (state.noProgressTurns > 0) {
    reasons.push(`${state.noProgressTurns} recent ${family} tool turn(s) contained too little grounded progress`);
  }
  if (state.repeatedCalls > 1 && state.lastName) {
    reasons.push(`${state.lastName} repeated ${state.repeatedCalls} time(s)`);
  }
  if (state.repeatedFamilies >= limit.repeatedFamilyCountBeforeEscalation) {
    reasons.push(`${family} tool family repeated ${state.repeatedFamilies} time(s) without a phase change`);
  }
  if (state.lowSignalResults > 1) {
    reasons.push(`${state.lowSignalResults} low-signal tool result(s) repeated without new evidence`);
  }

  let stage: ProgressEscalationStage = 'none';
  if (candidate && state.repeatedCalls > policy.exactRepeatedToolCallLimit && state.noProgressTurns > 0) {
    stage = 'block';
  } else if (
    state.noProgressTurns >= limit.noProgressTurnsBeforeBlock &&
    state.repeatedFamilies >= limit.repeatedFamilyCountBeforeEscalation
  ) {
    stage = candidate ? 'block' : 'force-summary';
  } else if (state.noProgressTurns >= limit.noProgressTurnsBeforeSummary) {
    stage = 'force-summary';
  } else if (state.noProgressTurns >= limit.noProgressTurnsBeforeReplan) {
    stage = 'inject-replan';
  } else if (state.noProgressTurns >= limit.noProgressTurnsBeforeNarrow) {
    stage = 'narrow-tools';
  } else if (reasons.length > 0) {
    stage = 'log';
  }

  const score = clamp(
    100 - state.noProgressTurns * 14 - Math.max(0, state.repeatedCalls - 1) * 16 -
      Math.max(0, state.repeatedFamilies - 1) * 8 - state.lowSignalResults * 6 +
      state.visibleProgress * 6 + state.transitions * 5 + state.novelty * 3
  );
  return {
    stage,
    score,
    reasons,
    activeFamily: state.activeFamily,
    nextPreferredFamilies: inferNextToolFamilies(state.activeFamily),
    toolCallTurnsSinceGroundedResponse: state.turns,
    noProgressToolCallTurns: state.noProgressTurns,
    repeatedToolCallCount: state.repeatedCalls,
    repeatedToolFamilyCount: state.repeatedFamilies,
    productiveToolResults: state.productiveResults,
    lastToolCallName: state.lastName,
    lastToolFamily: state.lastFamily,
    shouldBlock: stage === 'block',
    narrowTools: ['narrow-tools', 'inject-replan', 'force-summary'].includes(stage),
    injectReplan: stage === 'inject-replan' || stage === 'force-summary',
    forceSummary: stage === 'force-summary',
  };
}

function getToolCalls(message: OpenAIMessage): ToolCall[] {
  if (!Array.isArray(message.tool_calls)) { return []; }
  const calls: ToolCall[] = [];
  for (const candidate of message.tool_calls) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !isRecord(candidate.function)) { continue; }
    if (typeof candidate.function.name === 'string' && typeof candidate.function.arguments === 'string') {
      calls.push({ id: candidate.id, name: candidate.function.name, arguments: candidate.function.arguments });
    }
  }
  return calls;
}

function batchFamily(calls: readonly ToolCall[]): ToolFamily {
  const families = [...new Set(calls.map((call) => inferToolFamily(call.name)))];
  return families.length === 1 ? families[0] : 'other';
}

function batchSignature(calls: readonly ToolCall[]): string {
  return calls.map(callSignature).join('|');
}

function callSignature(call: Pick<ToolCall, 'name' | 'arguments'>): string {
  const parsed = repairJsonObject(call.arguments);
  return `${call.name}:${parsed ? stableStringify(parsed) : call.arguments.trim()}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') { return JSON.stringify(value); }
  if (Array.isArray(value)) { return `[${value.map(stableStringify).join(',')}]`; }
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
    .join(',')}}`;
}

function isGroundedAssistant(message: OpenAIMessage, minimum: number): boolean {
  return message.role === 'assistant' && getToolCalls(message).length === 0 &&
    extractText(message.content).trim().length >= minimum;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') { return content; }
  if (!Array.isArray(content)) { return ''; }
  return content.map((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '').join('');
}

function emptyState(): ProgressState {
  return {
    turns: 0, noProgressTurns: 0, repeatedCalls: 0, repeatedFamilies: 0,
    lowSignalResults: 0, productiveResults: 0, visibleProgress: 0,
    transitions: 0, novelty: 0, namesById: new Map(), signaturesById: new Map(),
    productiveSignatures: new Set(),
  };
}

function reset(state: ProgressState): void {
  const fresh = emptyState();
  state.turns = fresh.turns;
  state.noProgressTurns = fresh.noProgressTurns;
  state.repeatedCalls = fresh.repeatedCalls;
  state.repeatedFamilies = fresh.repeatedFamilies;
  state.lowSignalResults = fresh.lowSignalResults;
  state.productiveResults = fresh.productiveResults;
  state.visibleProgress = fresh.visibleProgress;
  state.transitions = fresh.transitions;
  state.novelty = fresh.novelty;
  state.lastName = undefined;
  state.lastSignature = undefined;
  state.lastFamily = undefined;
  state.lastResultSummary = undefined;
  state.activeFamily = undefined;
  state.namesById = fresh.namesById;
  state.signaturesById = fresh.signaturesById;
  state.productiveSignatures = fresh.productiveSignatures;
}

function thresholds(
  assistantCharacters: number,
  narrow: number,
  replan: number,
  summary: number,
  block: number,
  repeatedFamily: number
): ToolFamilyProgressThresholds {
  return {
    assistantCharacters,
    noProgressTurnsBeforeNarrow: narrow,
    noProgressTurnsBeforeReplan: replan,
    noProgressTurnsBeforeSummary: summary,
    noProgressTurnsBeforeBlock: block,
    repeatedFamilyCountBeforeEscalation: repeatedFamily,
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
