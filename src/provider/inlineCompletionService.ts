import type { CancellationToken } from 'vscode';
import {
  CompletionHttpError,
  GatewayClient,
  RequestCancelledError,
  RequestTimeoutError,
} from '../api/client';
import { OpenAICompletionRequest, OpenAICompletionResponse } from '../api/types';
import { GatewayConfig } from '../config/gatewayConfig';
import {
  buildCompletionRequestBody,
  cleanCompletionText,
  extractCompletionText,
  extractFimContext,
  FimContext,
  isSuffixUnsupportedError,
  shouldRequestCompletion,
} from '../completions/inlineCompletion';

interface InlineCompletionServiceDeps {
  client: GatewayClient;
  getConfig: () => GatewayConfig;
  /** Fallback model id when `inlineCompletionModel` isn't set — first model from the latest fetch. */
  getDefaultModelId: () => string | undefined;
  log: (message: string) => void;
}

/**
 * Orchestrates fill-in-the-middle completions against `/v1/completions`.
 * This runs alongside (not through) Copilot, which doesn't expose BYOK
 * models to its own inline suggestions (issue #44). Owns the
 * suffix-unsupported fallback state (vLLM — issue #51, LiteLLM — issue #68).
 */
export class InlineCompletionService {
  /**
   * Set once the server rejects the FIM `suffix` parameter (vLLM — issue #51, LiteLLM — issue #68).
   * Subsequent completions go prefix-only instead of failing on every
   * keystroke; cleared on config reload since the server may change.
   */
  private suffixUnsupported = false;

  /**
   * Set once the timeout advice has been logged, so a slow model doesn't
   * repeat it on every keystroke (issue #127). Cleared on config reload.
   */
  private timeoutReported = false;

  constructor(private readonly deps: InlineCompletionServiceDeps) {}

  /**
   * The server (or its capabilities) may have changed — probe suffix support
   * again and re-arm the one-shot timeout advice.
   */
  public resetServerState(): void {
    this.suffixUnsupported = false;
    this.timeoutReported = false;
  }

  /**
   * Produce a fill-in-the-middle completion for the text around the cursor, or
   * `undefined` when disabled, no model is available, the context is empty, or
   * the server errored.
   */
  public async provideCompletion(
    textBefore: string,
    textAfter: string,
    token: CancellationToken
  ): Promise<string | undefined> {
    const config = this.deps.getConfig();
    if (!config.enableInlineCompletion) {
      return undefined;
    }
    const model = this.resolveModel(config);
    if (!model) {
      this.deps.log(
        'Inline completion skipped: no model available. Set github.copilot.llm-gateway.inlineCompletionModel or refresh the model list.'
      );
      return undefined;
    }

    const context = extractFimContext(
      textBefore,
      textAfter,
      config.inlineCompletionMaxPrefixChars,
      config.inlineCompletionMaxSuffixChars
    );
    if (!shouldRequestCompletion(context)) {
      return undefined;
    }

    const request = buildCompletionRequestBody({
      model,
      context,
      maxTokens: config.inlineCompletionMaxTokens,
      includeSuffix: !this.suffixUnsupported,
    });

    // Superseded during the debounce — don't send a request nobody will see.
    if (token.isCancellationRequested) {
      return undefined;
    }

    try {
      return await this.fetchCompletionText(request, token, config);
    } catch (error) {
      if (
        request.suffix !== undefined &&
        error instanceof CompletionHttpError &&
        isSuffixUnsupportedError(error.status, error.body)
      ) {
        return this.retryWithoutSuffix(model, context, token, config);
      }
      // Completions are best-effort: a failure should silently yield no
      // suggestion rather than surfacing a toast on every keystroke.
      this.reportFailure(error, model, token, config);
      return undefined;
    }
  }

  /**
   * The server rejected the FIM `suffix` parameter — remember that and retry
   * the same completion prefix-only.
   */
  private async retryWithoutSuffix(
    model: string,
    context: FimContext,
    token: CancellationToken,
    config: GatewayConfig
  ): Promise<string | undefined> {
    this.suffixUnsupported = true;
    this.deps.log(
      'Inline completion: server rejected the FIM "suffix" parameter (vLLM does not implement it). ' +
        'Falling back to prefix-only completions — the text after the cursor will be ignored.'
    );
    try {
      return await this.fetchCompletionText(
        buildCompletionRequestBody({
          model,
          context,
          maxTokens: config.inlineCompletionMaxTokens,
          includeSuffix: false,
        }),
        token,
        config
      );
    } catch (retryError) {
      this.reportFailure(retryError, model, token, config);
      return undefined;
    }
  }

  /**
   * Log a failed completion. Cancellations (the user kept typing) are routine
   * and only logged verbosely; timeouts get one actionable message per config.
   */
  private reportFailure(
    error: unknown,
    model: string,
    token: CancellationToken,
    config: GatewayConfig
  ): void {
    if (error instanceof RequestCancelledError || token.isCancellationRequested) {
      if (config.verboseLogging) {
        // The token can fire while an unrelated error is in flight — keep it visible.
        const detail = error instanceof RequestCancelledError
          ? ''
          : `: ${error instanceof Error ? error.message : String(error)}`;
        this.deps.log(`Inline completion cancelled (superseded by newer request)${detail}`);
      }
      return;
    }
    if (error instanceof RequestTimeoutError) {
      this.reportTimeout(model, config);
      return;
    }
    this.deps.log(
      `Inline completion failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }

  private reportTimeout(model: string, config: GatewayConfig): void {
    const summary = `Inline completion timed out after ${config.inlineCompletionTimeout} ms for model "${model}".`;
    if (this.timeoutReported) {
      if (config.verboseLogging) {
        this.deps.log(summary);
      }
      return;
    }
    this.timeoutReported = true;
    this.deps.log(
      `${summary} Raise github.copilot.llm-gateway.inlineCompletionTimeout, or set ` +
        'github.copilot.llm-gateway.inlineCompletionModel to a small FIM/base code model — ' +
        'chat and reasoning models are usually too slow for ghost text. ' +
        'Further timeouts are only logged with verbose logging on.'
    );
  }

  /** Fire one `/v1/completions` request and normalise the result to ghost text. */
  private async fetchCompletionText(
    request: OpenAICompletionRequest,
    token: CancellationToken,
    config: GatewayConfig
  ): Promise<string | undefined> {
    if (config.verboseLogging) {
      this.deps.log(
        `Inline completion request: model=${request.model}, prompt=${request.prompt.length} chars, ` +
          `suffix=${request.suffix?.length ?? 0} chars, max_tokens=${request.max_tokens}, ` +
          `timeout=${config.inlineCompletionTimeout} ms`
      );
    }
    const startedAt = Date.now();
    const response = await this.deps.client.fetchCompletion(
      request,
      token,
      config.inlineCompletionTimeout
    );
    const text = cleanCompletionText(extractCompletionText(response));
    if (config.verboseLogging) {
      this.logOutcome(response, text, Date.now() - startedAt);
    }
    return text.length > 0 ? text : undefined;
  }

  private logOutcome(response: OpenAICompletionResponse, text: string, latencyMs: number): void {
    if (text.length > 0) {
      this.deps.log(`Inline completion response: ${text.length} chars in ${latencyMs} ms`);
      return;
    }
    const finishReason = response.choices?.[0]?.finish_reason ?? 'none';
    const hint = finishReason === 'length'
      ? ' — the max_tokens budget ran out before any text; reasoning models may spend it all on ' +
        'reasoning. Raise inlineCompletionMaxTokens or use a non-reasoning FIM/base model.'
      : '';
    this.deps.log(
      `Inline completion response: empty text in ${latencyMs} ms (finish_reason=${finishReason})${hint}`
    );
  }

  /**
   * Pick the model id for inline completions: the explicit
   * `inlineCompletionModel` setting if set, otherwise the first model from the
   * most recent successful fetch. Returns undefined when neither is available.
   */
  private resolveModel(config: GatewayConfig): string | undefined {
    const configured = config.inlineCompletionModel.trim();
    if (configured.length > 0) {
      return configured;
    }
    return this.deps.getDefaultModelId();
  }
}
