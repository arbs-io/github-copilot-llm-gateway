/**
 * Stable ids for streamed thinking blocks (issue #144).
 *
 * VS Code merges consecutive `LanguageModelThinkingPart`s into one thinking
 * block only when their `id` matches. Reported without an id, every streamed
 * `reasoning_content` delta became its own "Thought for 1s" block. This hands
 * out one id per reasoning phase: every part of a phase shares it, and ending
 * the phase (the `vscode_reasoning_done` marker) retires it, so a later phase
 * in the same reply — after a tool call, or interleaved with text — starts a
 * new block instead of being glued onto the previous one.
 *
 * Kept free of `vscode` so it can be unit-tested under `node --test`.
 */

let sequence = 0;

/** A process-unique id: distinct across phases, requests and replies. */
function nextThinkingId(): string {
  sequence += 1;
  return `gateway-thinking-${Date.now().toString(36)}-${sequence}`;
}

export class ThinkingBlockIds {
  private currentId: string | undefined;

  constructor(private readonly generate: () => string = nextThinkingId) {}

  /** Id of the open reasoning phase, opening a new one if none is open. */
  public current(): string {
    this.currentId ??= this.generate();
    return this.currentId;
  }

  /**
   * Close the open phase and return its id (or `undefined` when no phase was
   * open). The next {@link current} call starts a new block.
   */
  public end(): string | undefined {
    const id = this.currentId;
    this.currentId = undefined;
    return id;
  }
}
