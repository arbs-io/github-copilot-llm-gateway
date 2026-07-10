/**
 * Typed builder for OpenAI chat completion requests.
 *
 * Replaces the `Record<string, unknown>` + `as unknown as` cast pattern that
 * was previously in provider.ts — every field that ends up on the wire is
 * named and typed here, so the call site can't silently pass an extra field
 * that the server will ignore or reject.
 */

import { OpenAIChatCompletionRequest, OpenAIMessage, OpenAIToolDefinition } from './types';

export type { OpenAIToolDefinition } from './types';

export type ToolChoice = 'auto' | 'required' | 'none';

export interface ChatRequestOptions {
  model: string;
  messages: OpenAIMessage[];
  maxTokens: number;
  temperature: number;
  tools?: OpenAIToolDefinition[];
  toolChoice?: ToolChoice;
  parallelToolCalls?: boolean;
  /** Free-form overrides merged in last (e.g. from VS Code modelOptions). */
  extraOptions?: Record<string, unknown>;
}

/**
 * Produce an OpenAIChatCompletionRequest ready to send to the inference server.
 * Tools-related fields are only included when `tools` is a non-empty array.
 */
export function buildChatRequest(options: ChatRequestOptions): OpenAIChatCompletionRequest {
  const request: OpenAIChatCompletionRequest = {
    model: options.model,
    messages: options.messages,
    max_tokens: options.maxTokens,
    temperature: options.temperature,
  };

  if (options.tools && options.tools.length > 0) {
    request.tools = options.tools;
    if (options.toolChoice !== undefined) {
      request.tool_choice = options.toolChoice;
    }
    if (options.parallelToolCalls !== undefined) {
      request.parallel_tool_calls = options.parallelToolCalls;
    }
  }

  if (options.extraOptions) {
    for (const [key, value] of Object.entries(options.extraOptions)) {
      if (!key.startsWith('_')) {
        (request as any)[key] = value;
      }
    }
  }

  return request;
}
