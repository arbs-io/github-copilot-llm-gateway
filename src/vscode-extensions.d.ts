/**
 * Type augmentations for VS Code APIs that exist at runtime but are not yet
 * present in the @types/vscode version this project targets.
 */
import 'vscode';

declare module 'vscode' {
  /**
   * A part of a language model response that contains reasoning/thinking content.
   * Copilot Chat renders this in a dedicated collapsible "Thinking" UI block.
   *
   * @param value   The thinking text for this chunk.
   * @param id      Optional identifier for the thinking block (used for Anthropic extended thinking).
   * @param metadata  Optional metadata. Pass `{ vscode_reasoning_done: true }` to close the block.
   */
  export class LanguageModelThinkingPart {
    readonly value: string;
    readonly id: string | undefined;
    readonly metadata: Record<string, unknown> | undefined;
    constructor(value: string, id?: string, metadata?: Record<string, unknown>);
  }
}
