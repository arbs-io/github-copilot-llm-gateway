/**
 * Type definitions for OpenAI-compatible API responses
 */

export interface OpenAIModel {
  id: string;
  object: string;
  created: number;
  owned_by: string;
  /** vLLM, LiteLLM */
  max_model_len?: number;
  /** Ollama, LocalAI, LM Studio */
  context_length?: number;
  /** llama.cpp */
  context_window?: number;
  /**
   * llama.cpp nests model metadata here. `n_ctx` is the actual serving
   * context (`-c`); `n_ctx_train` the model's training context. In
   * llama-server router mode these appear only while the model is loaded
   * (issue #55).
   */
  meta?: {
    n_ctx?: number;
    n_ctx_train?: number;
    [key: string]: unknown;
  };
}

export interface OpenAIModelsResponse {
  object: string;
  data: OpenAIModel[];
}

/**
 * Wire-format message sent to an OpenAI-compatible chat endpoint.
 *
 * Typed loosely because we pass through a handful of provider-specific
 * variants (content can be string OR an array of text/image parts, tool
 * results appear as `role: 'tool'` messages, etc.). Treat it as the shape
 * that JSON.stringify will be called on.
 */
export type OpenAIMessage = Record<string, unknown>;

export interface OpenAIToolDefinition {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters?: unknown;
  };
}

export interface OpenAIChatCompletionRequest {
  model: string;
  messages: OpenAIMessage[];
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  top_p?: number;
  frequency_penalty?: number;
  presence_penalty?: number;
  tools?: OpenAIToolDefinition[];
  tool_choice?: 'auto' | 'required' | 'none';
  parallel_tool_calls?: boolean;
  [key: string]: unknown;
}

/**
 * Legacy `/v1/completions` request. Used by the experimental inline-completion
 * provider for fill-in-the-middle (FIM): `prompt` is the text before the
 * cursor and `suffix` the text after, which FIM-capable servers (vLLM,
 * llama.cpp, LM Studio, …) splice into the model's FIM template.
 */
export interface OpenAICompletionRequest {
  model: string;
  prompt: string;
  suffix?: string;
  max_tokens?: number;
  temperature?: number;
  stream?: boolean;
  stop?: string[];
  [key: string]: unknown;
}

export interface OpenAICompletionResponse {
  id?: string;
  object?: string;
  choices?: Array<{
    text?: string;
    index?: number;
    finish_reason?: string | null;
  }>;
}

export interface OpenAIChatCompletionChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: {
          name: string;
          arguments: string;
        };
      }>;
    };
    finish_reason: string | null;
  }>;
  /**
   * Present only on the trailing chunk when the request asked for
   * `stream_options.include_usage = true`. OpenAI omits `choices` (or sends
   * an empty array) on that chunk.
   */
  usage?: OpenAIUsage;
}

/**
 * OpenAI-compatible token usage stats. `prompt_tokens_details.cached_tokens`
 * is supported by OpenAI and a growing set of compatible servers; absent
 * elsewhere, we default to 0 when surfacing to VS Code.
 */
export interface OpenAIUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export interface OpenAIChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: {
      role: string;
      content: string;
    };
    finish_reason: string;
  }>;
  usage: OpenAIUsage;
}
