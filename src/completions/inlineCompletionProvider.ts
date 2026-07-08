import * as vscode from 'vscode';

/**
 * The slice of {@link GatewayProvider} the inline-completion provider needs.
 * Keeping it as a narrow interface decouples the VS Code surface from the
 * provider's internals and keeps the dependency direction one-way.
 */
export interface InlineCompletionBackend {
  isInlineCompletionEnabled(): boolean;
  getInlineCompletionDebounceMs(): number;
  provideInlineCompletion(
    textBefore: string,
    textAfter: string,
    token: vscode.CancellationToken
  ): Promise<string | undefined>;
}

/**
 * Resolve after `ms`, or immediately if cancellation fires first. Used to
 * debounce keystrokes — VS Code cancels the previous request when a new one
 * starts, so a superseded completion bails out before hitting the server.
 */
function delay(ms: number, token: vscode.CancellationToken): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    const sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      sub.dispose();
      resolve();
    });
  });
}

/**
 * Standalone inline (ghost-text) completion provider backed by the inference
 * server's `/v1/completions` endpoint. This exists because VS Code does not let
 * bring-your-own-key models power its own inline suggestions
 * (microsoft/vscode#318545) — so the gateway offers its own, running alongside
 * GitHub Copilot rather than through it. It is opt-in via
 * `github.copilot.llm-gateway.enableInlineCompletion`.
 */
export class GatewayInlineCompletionProvider
  implements vscode.InlineCompletionItemProvider
{
  constructor(private readonly backend: InlineCompletionBackend) {}

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    _context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken
  ): Promise<vscode.InlineCompletionItem[] | undefined> {
    if (!this.backend.isInlineCompletionEnabled()) {
      return undefined;
    }

    const debounceMs = this.backend.getInlineCompletionDebounceMs();
    if (debounceMs > 0) {
      await delay(debounceMs, token);
      if (token.isCancellationRequested) {
        return undefined;
      }
    }

    const textBefore = document.getText(
      new vscode.Range(new vscode.Position(0, 0), position)
    );
    const endPosition = document.lineAt(document.lineCount - 1).range.end;
    const textAfter = document.getText(new vscode.Range(position, endPosition));

    const completion = await this.backend.provideInlineCompletion(
      textBefore,
      textAfter,
      token
    );
    if (!completion || token.isCancellationRequested) {
      return undefined;
    }

    return [
      new vscode.InlineCompletionItem(completion, new vscode.Range(position, position)),
    ];
  }
}
