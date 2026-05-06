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
  usage: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

export interface GatewayConfig {
  serverUrl: string;
  apiKey?: string;
  requestTimeout: number;
  defaultMaxTokens: number;
  defaultMaxOutputTokens: number;
  enableImageInput: boolean;
  enableToolCalling: boolean;
  parallelToolCalling: boolean;
  agentTemperature: number;
  verboseLogging: boolean;
  customHeaders: Record<string, string>;
  extraModelOptions: Record<string, unknown>;
}
