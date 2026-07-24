import { OpenAIMessage } from '../api/types';

export type ToolFamily =
  | 'memory'
  | 'completion'
  | 'editing'
  | 'discovery'
  | 'execution'
  | 'network'
  | 'other';

export type ProgressEscalationStage =
  | 'none'
  | 'log'
  | 'narrow-tools'
  | 'inject-replan'
  | 'force-summary'
  | 'block';

export type SelectedToolReason =
  | 'pinned'
  | 'recent'
  | 'core'
  | 'active-family'
  | 'next-family'
  | 'completion'
  | 'editing'
  | 'discovery'
  | 'execution'
  | 'network'
  | 'discretionary';

export interface ToolFamilyProgressThresholds {
  assistantCharacters: number;
  noProgressTurnsBeforeNarrow: number;
  noProgressTurnsBeforeReplan: number;
  noProgressTurnsBeforeSummary: number;
  noProgressTurnsBeforeBlock: number;
  repeatedFamilyCountBeforeEscalation: number;
}

export interface ProgressPolicy {
  exactRepeatedToolCallLimit: number;
  groundedAssistantCharacters: number;
  toolResultSummaryCharacters: number;
  toolFamilyProgress: Record<ToolFamily, ToolFamilyProgressThresholds>;
}

export interface ProgressEvaluation {
  stage: ProgressEscalationStage;
  score: number;
  reasons: string[];
  activeFamily?: ToolFamily;
  nextPreferredFamilies: ToolFamily[];
  toolCallTurnsSinceGroundedResponse: number;
  noProgressToolCallTurns: number;
  repeatedToolCallCount: number;
  repeatedToolFamilyCount: number;
  productiveToolResults: number;
  lastToolCallName?: string;
  lastToolFamily?: ToolFamily;
  shouldBlock: boolean;
  narrowTools: boolean;
  injectReplan: boolean;
  forceSummary: boolean;
}

export interface SelectedTool<T extends { name: string }> {
  tool: T;
  family: ToolFamily;
  reason: SelectedToolReason;
}

export interface CompactionPolicy {
  taskAnchorCharacters: number;
  archivedSummaryCharacters: number;
  groundedAssistantCharacters: number;
  toolResultSummaryCharacters: number;
  reserveTokensForSyntheticMessages: number;
}

export interface ConversationCompactionResult {
  messages: OpenAIMessage[];
  estimatedInputTokens: number;
  totalEstimatedTokens: number;
  truncatedMessageCount: number;
  wasCompacted: boolean;
  taskAnchorApplied: boolean;
  archivedSummaryApplied: boolean;
  keptLatestGroundedSummary: boolean;
  preservedActiveToolChain: boolean;
  droppedMessageCount: number;
  syntheticMessages: OpenAIMessage[];
  summaryNotes: string[];
}
