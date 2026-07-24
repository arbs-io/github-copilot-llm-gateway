import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import nodeModule from 'node:module';
import { ToolCallBatchError } from '../../chat/responseStreamer';
import { OpenAIChatCompletionRequest } from '../../api/types';

interface ModuleLoader {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
}

const loader = nodeModule as unknown as ModuleLoader;
const originalLoad = loader._load;
class TextPart {
  constructor(public readonly value: string) {}
}
class ThinkingPart {
  constructor(
    public readonly value: string,
    public readonly id?: string,
    public readonly metadata?: Record<string, unknown>
  ) {}
}
class ToolCallPart {
  constructor(
    public readonly callId: string,
    public readonly name: string,
    public readonly input: Record<string, unknown>
  ) {}
}
class ToolResultPart {
  constructor(
    public readonly callId: string,
    public readonly content: unknown
  ) {}
}
class DataPart {
  constructor(
    public readonly data: Uint8Array,
    public readonly mimeType: string
  ) {}
}
const vscodeMock = {
  LanguageModelChatToolMode: { Required: 1, Auto: 2 },
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  ConfigurationTarget: { Global: 1 },
  LanguageModelTextPart: TextPart,
  LanguageModelThinkingPart: ThinkingPart,
  LanguageModelToolCallPart: ToolCallPart,
  LanguageModelToolResultPart: ToolResultPart,
  LanguageModelDataPart: DataPart,
  window: { showErrorMessage: () => Promise.resolve(undefined) },
  workspace: {
    getConfiguration: () => ({ update: () => Promise.resolve() }),
  },
  commands: { executeCommand: () => Promise.resolve() },
};
loader._load = (request, parent, isMain) =>
  request === 'vscode' ? vscodeMock : originalLoad(request, parent, isMain);
const chatRequestHandler = require('../chatRequestHandler') as typeof import('../chatRequestHandler');
const {
  assertUsableRequestPlan,
  buildProgressPolicy,
  calculateWorkingInputTokens,
  classifyRecoverableFailure,
  nextRecoveryStage,
  shouldExposeTools,
} = chatRequestHandler;
loader._load = originalLoad;

function testConfig() {
  return {
    enableImageInput: false,
    enableToolCalling: true,
    parallelToolCalling: true,
    agentTemperature: 0,
    pinnedTools: [],
    verboseDiagnostics: false,
    maxToolsPerRequest: 8,
    maxToolSchemaTokens: 4096,
    maxToolResultCharacters: 1000,
    maxConsecutiveToolCalls: 12,
    maxRepeatedToolCallCount: 3,
    verboseLogging: false,
    extraModelOptions: {},
    perModelOptions: {},
    maxAgentInputTokens: 16000,
  };
}

describe('ChatRequestHandler hardening integration', () => {
  test('gates tools by both configuration and model capability', () => {
    assert.equal(shouldExposeTools(true, true), true);
    assert.equal(shouldExposeTools(true, 1), true);
    assert.equal(shouldExposeTools(true, false), false);
    assert.equal(shouldExposeTools(true, undefined), false);
    assert.equal(shouldExposeTools(false, true), false);
  });

  test('derives loop thresholds from configured consecutive and repeat caps', () => {
    const policy = buildProgressPolicy({
      maxConsecutiveToolCalls: 12,
      maxRepeatedToolCallCount: 3,
      maxToolResultCharacters: 300,
    });

    assert.equal(policy.exactRepeatedToolCallLimit, 3);
    assert.equal(policy.toolResultSummaryCharacters, 300);
    assert.equal(policy.toolFamilyProgress.discovery.noProgressTurnsBeforeNarrow, 3);
    assert.equal(policy.toolFamilyProgress.discovery.noProgressTurnsBeforeReplan, 6);
    assert.equal(policy.toolFamilyProgress.discovery.noProgressTurnsBeforeSummary, 9);
    assert.equal(policy.toolFamilyProgress.discovery.noProgressTurnsBeforeBlock, 12);
  });

  test('fails clearly instead of forcing an impossible 64-token output', () => {
    assert.throws(
      () =>
        assertUsableRequestPlan({
          originalMessageCount: 2,
          requestMessageCount: 0,
          preservedActiveToolChain: true,
          safeMaxOutputTokens: 0,
          modelMaxContext: 128,
        }),
      /cannot fit safely in 128 context tokens/
    );
  });

  test('applies the agent input cap only while tools are exposed', () => {
    assert.equal(calculateWorkingInputTokens(120_000, 65_536, true), 65_536);
    assert.equal(calculateWorkingInputTokens(120_000, 65_536, false), 120_000);
    assert.equal(calculateWorkingInputTokens(-1, 65_536, false), 0);
  });

  test('rejects compaction that would orphan the active tool chain', () => {
    assert.throws(
      () =>
        assertUsableRequestPlan({
          originalMessageCount: 4,
          requestMessageCount: 2,
          preservedActiveToolChain: false,
          safeMaxOutputTokens: 512,
          modelMaxContext: 4096,
        }),
      /Reduce the conversation or tool budget/
    );
  });

  test('plans deterministic recovery stages and stops after the summary stage', () => {
    assert.equal(nextRecoveryStage('original', 2), 'serialized-tools');
    assert.equal(nextRecoveryStage('serialized-tools', 2), 'tool-free-summary');
    assert.equal(nextRecoveryStage('original', 0), 'tool-free-summary');
    assert.equal(nextRecoveryStage('tool-free-summary', 2), undefined);
  });

  test('classifies only known tool-generation failures as recoverable', () => {
    assert.equal(
      classifyRecoverableFailure(
        new ToolCallBatchError(
          { id: 'call_1', name: 'read_file', arguments: '{}' },
          'arguments were not a valid JSON object'
        )
      ),
      'strict-tool-batch'
    );
    assert.equal(
      classifyRecoverableFailure(new Error('grammar rejected output')),
      'tool-format'
    );
    assert.equal(
      classifyRecoverableFailure(new Error('HarmonyError: failed to parse tool call')),
      'tool-format'
    );
    assert.equal(
      classifyRecoverableFailure(new Error('tool_call parser produced malformed output')),
      'tool-format'
    );
  });

  test('does not recover authentication, network, cancellation, partial, or generic failures', () => {
    assert.equal(
      classifyRecoverableFailure(new Error('Chat completion failed: 401 Unauthorized')),
      undefined
    );
    assert.equal(classifyRecoverableFailure(new Error('fetch failed: ECONNREFUSED')), undefined);
    assert.equal(classifyRecoverableFailure(new Error('request was cancelled')), undefined);
    const partial = new Error('stream ended without a terminal signal');
    partial.name = 'GatewayPartialStreamError';
    assert.equal(classifyRecoverableFailure(partial), undefined);
    assert.equal(
      classifyRecoverableFailure(new Error('Chat completion failed: 500 Internal Server Error')),
      undefined
    );
  });

  test('recovers a grammar failure through serialized tools then an empty response through a tool-free summary', async () => {
    const requests: OpenAIChatCompletionRequest[] = [];
    const reported: unknown[] = [];
    let streamCount = 0;
    const client = {
      streamChatCompletion: (request: OpenAIChatCompletionRequest) => {
        requests.push(request);
        streamCount++;
        return (async function* () {
          if (streamCount === 1) {
            throw new Error('grammar rejected output');
          }
          if (streamCount === 3) {
            yield { content: 'Recovered summary.' };
          }
        })();
      },
    };
    const config = testConfig();
    const handler = new chatRequestHandler.ChatRequestHandler({
      client,
      catalog: {
        resolveModelMaxContext: () => 32768,
        getDiscoveredParams: () => undefined,
        learnContextSizeFromError: () => false,
      },
      getConfig: () => config,
      log: () => undefined,
      onRequestState: () => undefined,
      onCompleted: () => undefined,
      showOutput: () => undefined,
    } as never);

    await handler.handle(
      {
        id: 'test-model',
        maxOutputTokens: 1024,
        capabilities: { toolCalling: true },
      } as never,
      [
        {
          role: vscodeMock.LanguageModelChatMessageRole.User,
          content: [new TextPart('Inspect the repository.')],
        },
      ] as never,
      {
        toolMode: vscodeMock.LanguageModelChatToolMode.Required,
        tools: [
          {
            name: 'read_file',
            description: 'Read a file',
            inputSchema: {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
          },
        ],
      } as never,
      { report: (part: unknown) => reported.push(part) } as never,
      { isCancellationRequested: false } as never
    );

    assert.equal(requests.length, 3);
    assert.equal(requests[0].tool_choice, 'required');
    assert.equal(requests[0].parallel_tool_calls, true);
    assert.equal(requests[1].tool_choice, 'auto');
    assert.equal(requests[1].parallel_tool_calls, false);
    assert.equal(requests[2].tools, undefined);
    assert.equal(requests[2].tool_choice, undefined);
    assert.match(
      String(requests[2].messages[0]?.content),
      /Do not call tools.*concise, grounded summary/
    );
    assert.equal((reported[0] as TextPart).value, 'Recovered summary.');
  });

  test('does not retry a recoverable failure after any response part was reported', async () => {
    let requestCount = 0;
    const reported: unknown[] = [];
    const handler = new chatRequestHandler.ChatRequestHandler({
      client: {
        streamChatCompletion: () => {
          requestCount++;
          return (async function* () {
            yield { content: 'Visible output.' };
            throw new Error('grammar rejected output');
          })();
        },
      },
      catalog: {
        resolveModelMaxContext: () => 32768,
        getDiscoveredParams: () => undefined,
        learnContextSizeFromError: () => false,
      },
      getConfig: () => testConfig(),
      log: () => undefined,
      onRequestState: () => undefined,
      onCompleted: () => undefined,
      showOutput: () => undefined,
    } as never);

    await assert.rejects(
      handler.handle(
        {
          id: 'test-model',
          maxOutputTokens: 1024,
          capabilities: { toolCalling: true },
        } as never,
        [
          {
            role: vscodeMock.LanguageModelChatMessageRole.User,
            content: [new TextPart('Inspect the repository.')],
          },
        ] as never,
        {
          toolMode: vscodeMock.LanguageModelChatToolMode.Auto,
          tools: [
            {
              name: 'read_file',
              description: 'Read a file',
              inputSchema: { type: 'object' },
            },
          ],
        } as never,
        { report: (part: unknown) => reported.push(part) } as never,
        { isCancellationRequested: false } as never
      ),
      /grammar rejected output/
    );

    assert.equal(requestCount, 1);
    assert.equal((reported[0] as TextPart).value, 'Visible output.');
  });
});
