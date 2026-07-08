import * as vscode from 'vscode';
import { GatewayProvider } from '../provider/gatewayProvider';
import { StatusBarManager } from '../status/statusBarManager';
import { configureServerFlow } from './configureServer';
import { editCustomHeadersFlow } from './customHeaders';

/**
 * Register every user-facing command the extension contributes. Kept out of
 * `extension.ts` so activation stays a thin wiring layer; the interactive
 * flows themselves live in `configureServer.ts` / `customHeaders.ts`.
 */
export function registerCommands(
  context: vscode.ExtensionContext,
  provider: GatewayProvider,
  statusManager: StatusBarManager,
  refreshStatusBar: () => Promise<void>
): void {
  // Tooltip's "Show output log" link needs a registered command (command-link
  // anchors can't call class methods directly). Tiny wrapper around
  // provider.showOutput.
  context.subscriptions.push(
    vscode.commands.registerCommand('github.copilot.llm-gateway.showOutput', () =>
      provider.showOutput()
    )
  );

  context.subscriptions.push(
    vscode.commands.registerCommand(
      'github.copilot.llm-gateway.testConnection',
      async () => {
        const cts = new vscode.CancellationTokenSource();
        try {
          const models = await provider.provideLanguageModelChatInformation(
            { silent: false },
            cts.token
          );

          if (models.length > 0) {
            statusManager.setIdle(models.map((m) => m.id));
            vscode.window.showInformationMessage(
              `GitHub Copilot LLM Gateway: Successfully connected! Found ${models.length} model(s): ${models.map((m) => m.name).join(', ')}`
            );
          } else {
            statusManager.setNoModels();
            vscode.window.showWarningMessage(
              'GitHub Copilot LLM Gateway: Connected but no models found.'
            );
          }
        } catch (error) {
          statusManager.setError(error instanceof Error ? error.message : String(error));
          vscode.window.showErrorMessage(
            `GitHub Copilot LLM Gateway: Connection test failed. ${error instanceof Error ? error.message : String(error)}`
          );
        } finally {
          cts.dispose();
        }
      }
    )
  );

  // "Configure Server" command — triggered by the "Add Models..." dropdown
  // via the managementCommand contribution.
  context.subscriptions.push(
    vscode.commands.registerCommand('github.copilot.llm-gateway.manage', () =>
      configureServerFlow(provider, refreshStatusBar)
    )
  );

  // "Edit Custom Headers" command — lets users manage additional HTTP
  // headers (e.g. `Authorization: Token …`, `Anthropic-Version`) without
  // touching settings.json. Values are persisted via SecretStorage because
  // these headers commonly carry credentials (issue #28).
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'github.copilot.llm-gateway.editCustomHeaders',
      async () => {
        await editCustomHeadersFlow(provider);
        provider.invalidateModelCache();
        provider.refreshModels();
        await refreshStatusBar();
      }
    )
  );

  // Explicit "Refresh Models" command — previously users could only trigger
  // a re-fetch by editing settings, which was confusing when models
  // temporarily went missing.
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'github.copilot.llm-gateway.refreshModels',
      async () => {
        // Invalidate the provider's cache so the next fetch is fresh, then
        // fire the change event (VS Code will re-call
        // provideLanguageModelChatInformation on its own schedule) and
        // update the status bar immediately.
        provider.invalidateModelCache();
        provider.refreshModels();
        await refreshStatusBar();
      }
    )
  );
}
