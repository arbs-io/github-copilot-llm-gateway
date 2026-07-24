import { OpenAIMessage } from '../api/types';
import { estimateTextTokens } from '../chat/tokenBudget';
import { inferToolFamily } from './toolMetadata';
import {
  ProgressEvaluation,
  SelectedTool,
  SelectedToolReason,
  ToolFamily,
} from './types';

const RECENT_TOOL_NAME_LIMIT = 12;

/**
 * Repository tools stay available before discretionary tools when a request
 * cap is tight. Ordering mirrors the normal inspect -> edit -> verify flow.
 */
const CORE_TOOL_PRIORITY = new Map<string, number>([
  ['read_file', 0],
  ['file_search', 1],
  ['grep_search', 2],
  ['list_dir', 3],
  ['create_file', 4],
  ['replace_string_in_file', 5],
  ['insert_edit_into_file', 6],
  ['run_in_terminal', 7],
  ['get_errors', 8],
  ['manage_todo_list', 9],
  ['get_terminal_output', 10],
]);

export interface ToolLike {
  name: string;
}

export interface ToolSelectionResult<T extends ToolLike> {
  items: T[];
  droppedCount: number;
  prioritizedNames: string[];
  droppedNames: string[];
  selectedTools: SelectedTool<T>[];
}

export interface SelectToolsInput<T extends ToolLike> {
  tools: readonly T[];
  maxTools: number;
  messages: readonly OpenAIMessage[];
  pinnedToolNames: readonly string[];
  progress: ProgressEvaluation;
}

export function selectToolsForRequest<T extends ToolLike>(
  input: SelectToolsInput<T>
): ToolSelectionResult<T> {
  const maxTools = normalizeLimit(input.maxTools, input.tools.length);
  const recentNames = getRecentToolNames(input.messages);
  const preferredFamilies = resolvePreferredFamilies(input.progress);

  const ranked: SelectedTool<T>[] = [];
  for (const tool of input.tools) {
    const reason = classifyReason(
      tool,
      input.pinnedToolNames,
      recentNames,
      input.progress,
      preferredFamilies
    );
    if (reason) {
      ranked.push({ tool, family: inferToolFamily(tool.name), reason });
    }
  }

  // Always prioritize before applying either the count cap here or the schema
  // cap downstream. Otherwise a large discretionary definition appearing
  // first could consume the schema budget and evict pinned/recent/core tools
  // even when the count cap itself is not active.
  ranked.sort(compareSelectedTools);
  const selectedTools = ranked.slice(0, maxTools);

  const items = selectedTools.map((entry) => entry.tool);
  const selectedNames = new Set(items.map((tool) => tool.name));
  const droppedNames = input.tools
    .map((tool) => tool.name)
    .filter((name) => !selectedNames.has(name));

  return {
    items,
    droppedCount: droppedNames.length,
    prioritizedNames: items.map((tool) => tool.name),
    droppedNames,
    selectedTools,
  };
}

export interface SchemaBudgetResult<T> {
  items: T[];
  droppedCount: number;
  droppedItems: T[];
  serializedTokens: number;
}

/**
 * Apply a schema budget using the exact JSON array that will be sent. Each
 * candidate is tested as part of `[...kept, candidate]`, so commas/brackets
 * and empty-array overhead are accounted for consistently with diagnostics.
 */
export function limitToolsBySchemaTokenBudget<T>(
  tools: readonly T[],
  maxTokens: number,
  serialize: (tool: T) => unknown = (tool) => tool
): SchemaBudgetResult<T> {
  const budget = normalizeLimit(maxTokens, Number.MAX_SAFE_INTEGER);
  const items: T[] = [];
  const serialized: unknown[] = [];
  const droppedItems: T[] = [];

  for (const tool of tools) {
    const candidate = [...serialized, serialize(tool)];
    if (estimateTextTokens(JSON.stringify(candidate)) <= budget) {
      serialized.push(candidate[candidate.length - 1]);
      items.push(tool);
    } else {
      droppedItems.push(tool);
    }
  }

  return {
    items,
    droppedCount: droppedItems.length,
    droppedItems,
    serializedTokens: estimateTextTokens(JSON.stringify(serialized)),
  };
}

export function estimateSerializedToolTokens<T>(
  tools: readonly T[],
  serialize: (tool: T) => unknown = (tool) => tool
): number {
  return estimateTextTokens(JSON.stringify(tools.map(serialize)));
}

function classifyReason<T extends ToolLike>(
  tool: T,
  pinnedToolNames: readonly string[],
  recentNames: ReadonlySet<string>,
  progress: ProgressEvaluation,
  preferredFamilies: ReadonlySet<ToolFamily>
): SelectedToolReason | undefined {
  const family = inferToolFamily(tool.name);
  if (pinnedToolNames.includes(tool.name)) { return 'pinned'; }
  if (recentNames.has(tool.name)) { return 'recent'; }
  if (CORE_TOOL_PRIORITY.has(tool.name.toLowerCase())) { return 'core'; }
  if (progress.activeFamily === family) { return 'active-family'; }
  if (progress.nextPreferredFamilies.includes(family)) { return 'next-family'; }
  if (preferredFamilies.has(family)) { return familyReason(family); }
  return progress.narrowTools ? undefined : 'discretionary';
}

function familyReason(family: ToolFamily): SelectedToolReason {
  switch (family) {
    case 'completion': return 'completion';
    case 'editing': return 'editing';
    case 'discovery': return 'discovery';
    case 'execution': return 'execution';
    case 'network': return 'network';
    case 'memory': return 'pinned';
    default: return 'discretionary';
  }
}

function resolvePreferredFamilies(progress: ProgressEvaluation): Set<ToolFamily> {
  if (progress.narrowTools) {
    return new Set(
      [progress.activeFamily, ...progress.nextPreferredFamilies, 'completion']
        .filter((family): family is ToolFamily => family !== undefined)
    );
  }
  return new Set(['memory', 'completion', 'editing', 'discovery', 'execution', 'network', 'other']);
}

function compareSelectedTools<T extends ToolLike>(
  left: SelectedTool<T>,
  right: SelectedTool<T>
): number {
  const priority = reasonPriority(left.reason) - reasonPriority(right.reason);
  if (priority !== 0) { return priority; }
  if (left.reason === 'core' && right.reason === 'core') {
    const corePriority =
      (CORE_TOOL_PRIORITY.get(left.tool.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER) -
      (CORE_TOOL_PRIORITY.get(right.tool.name.toLowerCase()) ?? Number.MAX_SAFE_INTEGER);
    if (corePriority !== 0) { return corePriority; }
  }
  // Modern JavaScript sort is stable. Preserve caller order within an equal
  // priority group so prioritization does not introduce unnecessary churn.
  return 0;
}

function reasonPriority(reason: SelectedToolReason): number {
  return [
    'pinned',
    'recent',
    'core',
    'active-family',
    'next-family',
    'completion',
    'editing',
    'discovery',
    'execution',
    'network',
    'discretionary',
  ].indexOf(reason);
}

function getRecentToolNames(messages: readonly OpenAIMessage[]): Set<string> {
  const names: string[] = [];
  for (let index = messages.length - 1; index >= 0; index--) {
    for (const call of getToolCalls(messages[index])) {
      if (!names.includes(call.name)) { names.push(call.name); }
      if (names.length >= RECENT_TOOL_NAME_LIMIT) { return new Set(names); }
    }
  }
  return new Set(names);
}

function getToolCalls(message: OpenAIMessage): Array<{ name: string }> {
  if (!Array.isArray(message.tool_calls)) { return []; }
  const calls: Array<{ name: string }> = [];
  for (const candidate of message.tool_calls) {
    if (!isRecord(candidate) || !isRecord(candidate.function) || typeof candidate.function.name !== 'string') {
      continue;
    }
    calls.push({ name: candidate.function.name });
  }
  return calls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeLimit(value: number, fallback: number): number {
  if (Number.isFinite(value) && value >= 0) { return Math.floor(value); }
  return Math.max(0, Math.floor(fallback));
}
