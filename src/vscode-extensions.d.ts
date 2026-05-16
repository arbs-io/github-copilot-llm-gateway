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
   * @param id      Optional identifier for the thinking block.
   * @param metadata  Optional metadata. Pass `{ vscode_reasoning_done: true }` to close the block.
   */
  export class LanguageModelThinkingPart {
    readonly value: string;
    readonly id: string | undefined;
    readonly metadata: Record<string, unknown> | undefined;
    constructor(value: string, id?: string, metadata?: Record<string, unknown>);
  }

  /**
   * Optional fields the Copilot Chat model picker renders if present.
   * Not yet declared on `LanguageModelChatInformation` in the bundled
   * `@types/vscode`; declared here so we don't need an unsafe cast.
   *
   * `isUserSelectable` was added in VS Code 1.120 and gates whether the
   * model appears directly in the chat model picker — without it, our
   * models only showed up in the read-only "Manage Models" list (issue #29).
   *
   * `multiplierNumeric` is part of the `chatProvider@4` proposed API used by
   * native Copilot Chat BYOK providers. Setting it to `0` keeps gateway models
   * from appearing to consume Copilot premium request quota.
   */
  interface LanguageModelChatInformation {
    description?: string;
    tooltip?: string;
    detail?: string;
    isUserSelectable?: boolean;
    multiplierNumeric?: number;
  }

  /**
   * Native Copilot Chat BYOK providers receive the user-configured API key
   * (and other declared schema properties) via the `configuration` field on
   * the options bag. This is part of the `chatProvider@4` proposed API; it's
   * present at runtime in VS Code 1.120 even though it isn't in the stable
   * `@types/vscode` yet. Falling back to SecretStorage when undefined keeps
   * us compatible with older builds.
   */
  interface PrepareLanguageModelChatModelOptions {
    readonly configuration?: { readonly [key: string]: unknown };
  }
}
