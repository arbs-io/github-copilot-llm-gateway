import * as vscode from 'vscode';
import { parseContextOverflowError } from '../chat/contextWindow';
import { DEFAULT_THINKING_EFFORT_PARAMETER, parseAcceptedEffortValues } from '../config/thinkingEffort';

type Logger = (message: string) => void;

/**
 * Error toast with an "Open Settings" action targeting the extension's
 * settings scope. Used for failures the user can fix in configuration
 * (bad server URL, context-window overrides, fetch failures).
 */
export function promptOpenSettings(message: string, log: Logger): void {
  vscode.window.showErrorMessage(message, 'Open Settings').then(
    (selection: string | undefined) => {
      if (selection === 'Open Settings') {
        vscode.commands.executeCommand(
          'workbench.action.openSettings',
          'github.copilot.llm-gateway'
        );
      }
    },
    (err: unknown) => {
      log(
        `Failed to show settings prompt: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  );
}

function promptToolCallingError(log: Logger, showOutput: () => void): void {
  vscode.window
    .showErrorMessage(
      `GitHub Copilot LLM Gateway: Model failed to generate valid tool calls. This model may not support function calling. Check Output panel for details.`,
      'Open Output',
      'Disable Tool Calling'
    )
    .then(
      (selection: string | undefined) => {
        if (selection === 'Open Output') {
          showOutput();
        } else if (selection === 'Disable Tool Calling') {
          vscode.workspace
            .getConfiguration('github.copilot.llm-gateway')
            .update('enableToolCalling', false, vscode.ConfigurationTarget.Global);
        }
      },
      (err: unknown) => {
        log(
          `Failed to show tool calling error prompt: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    );
}

/**
 * Log a failed chat request and surface the most actionable UI for it:
 * context-overflow errors point at `modelContextWindows`, tool-parser
 * errors offer to disable tool calling, a rejected thinking effort names the
 * values the server accepts, everything else gets the raw message. Always
 * throws so VS Code marks the chat turn as failed.
 */
export function handleChatError(
  error: unknown,
  log: Logger,
  showOutput: () => void,
  effortParameter: string = DEFAULT_THINKING_EFFORT_PARAMETER
): never {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorStack = error instanceof Error ? error.stack : '';

  log(`ERROR: Chat request failed: ${errorMessage}`);
  if (errorStack) {
    log(`Stack trace: ${errorStack}`);
  }

  // Be conservative — only treat the error as a tool-calling format error
  // when the message contains a known tool-parser signal. The previous
  // heuristic also matched on `unexpected tokens`, which appears in many
  // unrelated errors and was triggering the "may not support tool calling"
  // prompt incorrectly.
  const isToolError =
    errorMessage.includes('HarmonyError') ||
    /tool[_ -]?call.*parse/i.test(errorMessage);

  const overflowContext = parseContextOverflowError(errorMessage);
  const acceptedEfforts = parseAcceptedEffortValues(errorMessage, effortParameter);
  if (acceptedEfforts !== undefined) {
    // Issue #146: the catalog has already narrowed the model picker to these
    // values. Lead with the fix — the raw server body follows for reference —
    // in both the notification and the chat view's failure reason.
    const friendly =
      `The server rejected the thinking effort (${effortParameter}) for this model. ` +
      `It accepts: ${acceptedEfforts.join(', ')}. Choose one of these in the model picker's ` +
      `Thinking Effort menu (or with the Set Thinking Effort command) and resend.`;
    vscode.window.showErrorMessage(`GitHub Copilot LLM Gateway: ${friendly}`);
    throw new Error(`${friendly}\n\n${errorMessage}`);
  }
  if (overflowContext !== undefined) {
    // Reaching here means the learn-and-retry path couldn't recover
    // (output already streamed, or we were already budgeting within the
    // reported window and the char/4 estimate drifted). Give the user an
    // actionable fix instead of the raw server body.
    promptOpenSettings(
      `GitHub Copilot LLM Gateway: Request exceeded the model's context window (server reports ${overflowContext} tokens). ` +
        `Retry the request — the gateway now budgets for this limit. If it recurs, set 'modelContextWindows' for this model to a value below ${overflowContext}.`,
      log
    );
  } else if (isToolError) {
    log('HINT: This appears to be a tool calling format error.');
    log('The model may not support function calling properly.');
    log(
      'Try: 1) Using a different model, 2) Disabling tool calling in settings, or 3) Checking inference server logs'
    );
    promptToolCallingError(log, showOutput);
  } else {
    vscode.window.showErrorMessage(
      `GitHub Copilot LLM Gateway: Chat request failed. ${errorMessage}`
    );
  }

  throw error;
}
