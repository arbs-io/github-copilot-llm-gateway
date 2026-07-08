import type { CancellationToken } from 'vscode';
import { CompletionHttpError, GatewayClient } from '../api/client';
import { OpenAICompletionRequest } from '../api/types';
import { GatewayConfig } from '../config/gatewayConfig';
import {
  buildCompletionRequestBody,
  cleanCompletionText,
  extractCompletionText,
  extractFimContext,
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
 * suffix-unsupported fallback state (vLLM — issue #51).
 */
export class InlineCompletionService {
  /**
   * Set once the server rejects the FIM `suffix` parameter (vLLM — issue #51).
   * Subsequent completions go prefix-only instead of failing on every
   * keystroke; cleared on config reload since the server may change.
   */
  private suffixUnsupported = false;

  constructor(private readonly deps: InlineCompletionServiceDeps) {}

  /** The server (or its capabilities) may have changed — probe suffix support again. */
  public resetSuffixProbe(): void {
    this.suffixUnsupported = false;
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

    try {
      return await this.fetchCompletionText(request, token, config);
    } catch (error) {
      if (
        request.suffix !== undefined &&
        error instanceof CompletionHttpError &&
        isSuffixUnsupportedError(error.status, error.body)
      ) {
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
          this.deps.log(
            `Inline completion failed: ${retryError instanceof Error ? retryError.message : String(retryError)}`
          );
          return undefined;
        }
      }
      // Completions are best-effort: a failure should silently yield no
      // suggestion rather than surfacing a toast on every keystroke.
      this.deps.log(
        `Inline completion failed: ${error instanceof Error ? error.message : String(error)}`
      );
      return undefined;
    }
  }

  /** Fire one `/v1/completions` request and normalise the result to ghost text. */
  private async fetchCompletionText(
    request: OpenAICompletionRequest,
    token: CancellationToken,
    config: GatewayConfig
  ): Promise<string | undefined> {
    const response = await this.deps.client.fetchCompletion(
      request,
      token,
      config.inlineCompletionTimeout
    );
    const text = cleanCompletionText(extractCompletionText(response));
    return text.length > 0 ? text : undefined;
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
