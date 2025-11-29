import * as vscode from 'vscode';
import { GatewayProvider } from './provider';

/**
 * Extension activation
 */
export function activate(context: vscode.ExtensionContext) {
  console.log('GitHub Copilot LLM Gateway extension is now active');

  // Create and register the language model provider
  const provider = new GatewayProvider(context);

  const disposable = vscode.lm.registerLanguageModelChatProvider(
    'copilot-llm-gateway',
    provider
  );

  context.subscriptions.push(disposable);

  // Register a command to test the connection
  const testCommand = vscode.commands.registerCommand(
    'github.copilot.llm-gateway.testConnection',
    async () => {
      try {
        const models = await provider.provideLanguageModelChatInformation(
          { silent: false },
          new vscode.CancellationTokenSource().token
        );

        if (models.length > 0) {
          vscode.window.showInformationMessage(
            `GitHub Copilot LLM Gateway: Successfully connected! Found ${models.length} model(s): ${models.map(m => m.name).join(', ')}`
          );
        } else {
          vscode.window.showWarningMessage(
            'GitHub Copilot LLM Gateway: Connected but no models found.'
          );
        }
      } catch (error) {
        vscode.window.showErrorMessage(
          `GitHub Copilot LLM Gateway: Connection test failed. ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
  );

  context.subscriptions.push(testCommand);

  console.log('Copilot LLM Gateway provider registered with vendor ID: copilot-llm-gateway');
}

/**
 * Extension deactivation
 */
export function deactivate() {
  console.log('GitHub Copilot LLM Gateway extension is now deactivated');
}
