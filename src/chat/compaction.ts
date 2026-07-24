import { OpenAIMessage } from '../api/types';
import { ConversationCompactionResult, CompactionPolicy } from '../agent/types';
import { summarizeToolResult } from '../agent/toolMetadata';
import { estimateMessageTokens } from './tokenBudget';

interface ConversationUnit {
  messageIndices: number[];
  tokenCount: number;
  containsToolChain: boolean;
  groundedSummary: boolean;
  selectable: boolean;
}

interface UnitSelection {
  selected: Set<number>;
  usedTokens: number;
}

interface SyntheticHistory {
  messages: OpenAIMessage[];
  notes: string[];
}

interface CompactionResultInput {
  messages: OpenAIMessage[];
  estimatedInputTokens: number;
  totalEstimatedTokens: number;
  selectedOriginalCount: number;
  originalCount: number;
  syntheticMessages: OpenAIMessage[];
  summaryNotes: string[];
  compacted: boolean;
  latestGroundedKept: boolean;
  activeChainKept: boolean;
}

export interface CompactConversationInput {
  messages: readonly OpenAIMessage[];
  maxInputTokens: number;
  policy: CompactionPolicy;
  /** Output, tool-schema, and caller-specific reserve already expressed in tokens. */
  reservedTokens?: number;
}

export function compactConversationHistory(
  input: CompactConversationInput
): ConversationCompactionResult {
  const messages = [...input.messages];
  const totalEstimatedTokens = sumTokens(messages);
  const available = Math.max(
    0,
    Math.floor(input.maxInputTokens) - Math.max(0, Math.floor(input.reservedTokens ?? 0))
  );
  const units = buildConversationUnits(messages, input.policy.groundedAssistantCharacters);

  // The fast path is safe only when the original transcript has no orphaned
  // tool-result messages.
  if (totalEstimatedTokens <= available && units.every((unit) => unit.selectable)) {
    return createCompactionResult({
      messages,
      estimatedInputTokens: totalEstimatedTokens,
      totalEstimatedTokens,
      selectedOriginalCount: messages.length,
      originalCount: messages.length,
      syntheticMessages: [],
      summaryNotes: [],
      compacted: false,
      latestGroundedKept: findLatestGroundedUnit(units) !== undefined,
      activeChainKept: true,
    });
  }

  const activeUnit = findLatestToolChainUnit(units);
  const groundedUnit = findLatestGroundedUnit(units);
  const systemUnit = findFirstRoleUnit(units, messages, 'system');
  const protectedUnits = unique([systemUnit, activeUnit, groundedUnit]);
  const reserve = Math.min(available, Math.max(0, input.policy.reserveTokensForSyntheticMessages));
  const selection = selectConversationUnits(units, protectedUnits, available, reserve);

  const selectedIndices = [...selection.selected]
    .sort((left, right) => left - right)
    .flatMap((unitIndex) => units[unitIndex].messageIndices);
  const selectedIndexSet = new Set(selectedIndices);
  const omitted = messages.filter((_, index) => !selectedIndexSet.has(index));
  const synthetic = buildSyntheticHistory(
    messages,
    selectedIndexSet,
    omitted,
    input.policy,
    Math.max(0, available - selection.usedTokens)
  );

  const selectedMessages = selectedIndices.map((index) => messages[index]);
  const firstSelectedIsSystem = selectedMessages[0]?.role === 'system';
  const finalMessages = firstSelectedIsSystem
    ? [selectedMessages[0], ...synthetic.messages, ...selectedMessages.slice(1)]
    : [...synthetic.messages, ...selectedMessages];

  return createCompactionResult({
    messages: finalMessages,
    estimatedInputTokens: sumTokens(finalMessages),
    totalEstimatedTokens,
    selectedOriginalCount: selectedIndices.length,
    originalCount: messages.length,
    syntheticMessages: synthetic.messages,
    summaryNotes: synthetic.notes,
    compacted: true,
    latestGroundedKept: groundedUnit !== undefined && selection.selected.has(groundedUnit),
    activeChainKept: activeUnit === undefined || selection.selected.has(activeUnit),
  });
}

function selectConversationUnits(
  units: readonly ConversationUnit[],
  protectedUnits: readonly number[],
  available: number,
  reserve: number
): UnitSelection {
  const selected = new Set<number>();
  let usedTokens = selectProtectedUnits(units, protectedUnits, available, selected);
  const recentBudget = Math.max(usedTokens, available - reserve);

  for (let index = units.length - 1; index >= 0; index--) {
    const unit = units[index];
    if (selected.has(index) || !unit.selectable) { continue; }
    if (usedTokens + unit.tokenCount > recentBudget) { continue; }
    selected.add(index);
    usedTokens += unit.tokenCount;
  }
  return { selected, usedTokens };
}

function selectProtectedUnits(
  units: readonly ConversationUnit[],
  protectedUnits: readonly number[],
  available: number,
  selected: Set<number>
): number {
  let usedTokens = 0;
  // Essential units are indivisible. If one cannot fit, it is omitted rather
  // than leaving an assistant call or tool result orphaned.
  for (const unitIndex of protectedUnits) {
    const unit = units[unitIndex];
    if (!unit.selectable || usedTokens + unit.tokenCount > available) { continue; }
    selected.add(unitIndex);
    usedTokens += unit.tokenCount;
  }
  return usedTokens;
}

function buildSyntheticHistory(
  messages: readonly OpenAIMessage[],
  selectedIndices: ReadonlySet<number>,
  omitted: readonly OpenAIMessage[],
  policy: CompactionPolicy,
  tokenBudget: number
): SyntheticHistory {
  const synthetic: OpenAIMessage[] = [];
  const notes: string[] = [];
  const remaining = addTaskAnchor(messages, selectedIndices, policy, tokenBudget, synthetic, notes);
  addArchiveSummary(messages, omitted, policy, remaining, synthetic, notes);
  return { messages: synthetic, notes };
}

function addTaskAnchor(
  messages: readonly OpenAIMessage[],
  selectedIndices: ReadonlySet<number>,
  policy: CompactionPolicy,
  tokenBudget: number,
  synthetic: OpenAIMessage[],
  notes: string[]
): number {
  const firstUserIndex = messages.findIndex((message) => message.role === 'user');
  if (firstUserIndex < 0 || selectedIndices.has(firstUserIndex)) { return tokenBudget; }
  const anchor = fitSyntheticMessage(
    'user',
    'Task anchor: ',
    extractText(messages[firstUserIndex].content),
    policy.taskAnchorCharacters,
    tokenBudget
  );
  if (!anchor) { return tokenBudget; }
  synthetic.push(anchor);
  notes.push('Preserved the first user objective as a synthetic task anchor.');
  return tokenBudget - estimateMessageTokens(anchor);
}

function addArchiveSummary(
  messages: readonly OpenAIMessage[],
  omitted: readonly OpenAIMessage[],
  policy: CompactionPolicy,
  tokenBudget: number,
  synthetic: OpenAIMessage[],
  notes: string[]
): void {
  if (omitted.length === 0) { return; }
  const archiveBody = buildArchiveBody(
    omitted,
    buildToolNamesByCallId(messages),
    policy.toolResultSummaryCharacters
  );
  const archive = fitSyntheticMessage(
    'user',
    'Archived history:\n',
    archiveBody,
    policy.archivedSummaryCharacters,
    tokenBudget
  );
  if (!archive) { return; }
  synthetic.push(archive);
  notes.push(`Archived ${omitted.length} older message(s) into a deterministic summary.`);
}

function createCompactionResult(input: CompactionResultInput): ConversationCompactionResult {
  const dropped = input.originalCount - input.selectedOriginalCount;
  return {
    messages: input.messages,
    estimatedInputTokens: input.estimatedInputTokens,
    totalEstimatedTokens: input.totalEstimatedTokens,
    truncatedMessageCount: dropped,
    wasCompacted: input.compacted,
    taskAnchorApplied: input.syntheticMessages.some((message) =>
      typeof message.content === 'string' && message.content.startsWith('Task anchor:')
    ),
    archivedSummaryApplied: input.syntheticMessages.some((message) =>
      typeof message.content === 'string' && message.content.startsWith('Archived history:')
    ),
    keptLatestGroundedSummary: input.latestGroundedKept,
    preservedActiveToolChain: input.activeChainKept,
    droppedMessageCount: dropped,
    syntheticMessages: input.syntheticMessages,
    summaryNotes: input.summaryNotes,
  };
}

function buildConversationUnits(
  messages: readonly OpenAIMessage[],
  groundedCharacters: number
): ConversationUnit[] {
  const units: ConversationUnit[] = [];
  let index = 0;
  while (index < messages.length) {
    const calls = getToolCalls(messages[index]);
    if (calls.length > 0) {
      const callIds = new Set(calls.map((call) => call.id));
      const messageIndices = [index];
      let next = index + 1;
      while (
        next < messages.length &&
        messages[next].role === 'tool' &&
        typeof messages[next].tool_call_id === 'string' &&
        callIds.has(messages[next].tool_call_id as string)
      ) {
        messageIndices.push(next++);
      }
      units.push({
        messageIndices,
        tokenCount: sumTokens(messageIndices.map((messageIndex) => messages[messageIndex])),
        containsToolChain: true,
        groundedSummary: false,
        selectable: true,
      });
      index = next;
      continue;
    }

    const orphanToolResult = messages[index].role === 'tool';
    units.push({
      messageIndices: [index],
      tokenCount: estimateMessageTokens(messages[index]),
      containsToolChain: false,
      groundedSummary:
        messages[index].role === 'assistant' &&
        extractText(messages[index].content).trim().length >= groundedCharacters,
      selectable: !orphanToolResult,
    });
    index++;
  }
  return units;
}

function fitSyntheticMessage(
  role: 'user' | 'assistant',
  prefix: string,
  body: string,
  maxCharacters: number,
  tokenBudget: number
): OpenAIMessage | undefined {
  if (tokenBudget <= 0 || maxCharacters <= 0 || body.trim().length === 0) { return undefined; }
  const normalized = body.trim().replace(/\s+/g, ' ');
  const minimumContent = `${prefix}${normalized[0]}`.trim();
  if (estimateMessageTokens({ content: minimumContent }) > tokenBudget) {
    return undefined;
  }
  let content = `${prefix}${normalized.slice(0, Math.max(0, maxCharacters - prefix.length))}`.trim();
  while (content.length >= minimumContent.length) {
    // Compacted previews can contain adversarial user or tool output. Keep
    // them at conversation authority; promoting them to `system` would turn
    // quoted prompt injection into trusted instructions.
    const message: OpenAIMessage = { role, content };
    if (estimateMessageTokens(message) <= tokenBudget) { return message; }
    content = content.slice(0, Math.max(minimumContent.length, content.length - 16)).trim();
  }
  return undefined;
}

function buildArchiveBody(
  omitted: readonly OpenAIMessage[],
  toolNames: ReadonlyMap<string, string>,
  summaryCharacters: number
): string {
  const lines: string[] = [];
  for (const message of omitted) {
    if (message.role === 'user') {
      lines.push(`- user: ${trimPreview(extractText(message.content), 120)}`);
    } else if (getToolCalls(message).length > 0) {
      lines.push(`- tools: ${getToolCalls(message).map((call) => call.name).join(', ')}`);
    } else if (message.role === 'tool' && typeof message.tool_call_id === 'string') {
      const name = toolNames.get(message.tool_call_id) ?? 'tool';
      lines.push(`- ${summarizeToolResult(name, extractText(message.content), summaryCharacters).summary}`);
    } else if (message.role === 'assistant') {
      lines.push(`- assistant: ${trimPreview(extractText(message.content), 100)}`);
    }
  }
  return lines.filter((line) => !/:\s*$/.test(line)).join('\n');
}

function getToolCalls(message: OpenAIMessage): Array<{ id: string; name: string }> {
  if (!Array.isArray(message.tool_calls)) { return []; }
  const calls: Array<{ id: string; name: string }> = [];
  for (const candidate of message.tool_calls) {
    if (!isRecord(candidate) || typeof candidate.id !== 'string' || !isRecord(candidate.function)) {
      continue;
    }
    if (typeof candidate.function.name === 'string') {
      calls.push({ id: candidate.id, name: candidate.function.name });
    }
  }
  return calls;
}

function extractText(content: unknown): string {
  if (typeof content === 'string') { return content; }
  if (!Array.isArray(content)) { return ''; }
  return content
    .map((part) => isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '')
    .join('');
}

function buildToolNamesByCallId(messages: readonly OpenAIMessage[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const message of messages) {
    for (const call of getToolCalls(message)) { names.set(call.id, call.name); }
  }
  return names;
}

function findLatestToolChainUnit(units: readonly ConversationUnit[]): number | undefined {
  for (let index = units.length - 1; index >= 0; index--) {
    if (units[index].containsToolChain) { return index; }
  }
  return undefined;
}

function findLatestGroundedUnit(units: readonly ConversationUnit[]): number | undefined {
  for (let index = units.length - 1; index >= 0; index--) {
    if (units[index].groundedSummary) { return index; }
  }
  return undefined;
}

function findFirstRoleUnit(
  units: readonly ConversationUnit[],
  messages: readonly OpenAIMessage[],
  role: string
): number | undefined {
  const messageIndex = messages.findIndex((message) => message.role === role);
  return messageIndex < 0 ? undefined : units.findIndex((unit) => unit.messageIndices.includes(messageIndex));
}

function unique(values: Array<number | undefined>): number[] {
  return [...new Set(values.filter((value): value is number => value !== undefined && value >= 0))];
}

function sumTokens(messages: readonly OpenAIMessage[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

function trimPreview(content: string, maxCharacters: number): string {
  const normalized = content.trim().replace(/\s+/g, ' ');
  return normalized.length <= maxCharacters
    ? normalized
    : `${normalized.slice(0, Math.max(0, maxCharacters - 3))}...`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
