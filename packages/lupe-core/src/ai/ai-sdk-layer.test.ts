import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { Effect, Layer } from 'effect';
import { describe, expect, test } from 'vitest';

import { RepoSource } from '../ports';
import { AiSdkLive } from './ai-sdk-layer';
import { FINAL_FINDINGS_TURN } from './collect-findings';
import { AiModel } from './model';
import { anthropicThinkingBinding } from './usage';

type GenerateOptions = Parameters<MockLanguageModelV3['doGenerate']>[0];
type GenerateResult = Awaited<ReturnType<MockLanguageModelV3['doGenerate']>>;

const FINDING = {
  ruleId: 'lupe/correctness/off-by-one',
  title: 'Off by one',
  path: 'a.ts',
  startLine: 1,
  endLine: 1,
  side: 'RIGHT' as const,
  severity: 'high' as const,
  category: 'correctness' as const,
  message: 'The loop bound is exclusive.',
  confidence: 0.9,
  evidence: [] as [],
};

function usage(): GenerateResult['usage'] {
  return {
    inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 },
  };
}

function textResult(text: string, finish: 'stop' | 'length' | 'tool-calls'): GenerateResult {
  return {
    content: [{ type: 'text', text }],
    finishReason: { unified: finish, raw: finish },
    usage: usage(),
    warnings: [],
  };
}

function toolCallResult(id: string): GenerateResult {
  return {
    content: [
      {
        type: 'tool-call',
        toolCallId: id,
        toolName: 'readFile',
        input: JSON.stringify({ path: 'a.ts' }),
      },
    ],
    finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
    usage: usage(),
    warnings: [],
  };
}

function findingsText(): string {
  return JSON.stringify({ elements: [FINDING] });
}

function promptOf(options: GenerateOptions): string {
  return JSON.stringify(options.prompt);
}

const repoLayer = Layer.succeed(RepoSource, {
  acquireDiff: () => Effect.succeed([]),
  readFile: () => Effect.succeed('export const a = 1;\n'),
  listDir: () => Effect.succeed([]),
  grep: () => Effect.succeed([]),
});

function run(
  model: MockLanguageModelV3,
  maxSteps?: number,
  config?: { provider?: 'anthropic' | 'openai'; models?: { review?: string; verify?: string } }
) {
  const ai = AiSdkLive({
    provider: config?.provider ?? 'anthropic',
    apiKey: 'test',
    languageModel: model,
    ...(config?.models ? { models: config.models } : {}),
  }).pipe(Layer.provide(repoLayer));
  return Effect.gen(function* () {
    const svc = yield* AiModel;
    return yield* svc.generateFindings({
      task: 'review',
      system: 'You are lupe.',
      prompt: 'diff of a.ts',
      maxSteps,
    });
  }).pipe(Effect.provide(ai));
}

const THINKING_BINDING = {
  anthropic: {
    thinking: { type: 'adaptive', blockBinding: { prefixMismatchBehavior: 'drop_block' } },
  },
};

describe('generateFindings tool loop', () => {
  test('a stop with valid findings does not take an extra call', async () => {
    const calls: GenerateOptions[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push(options);
        return textResult(findingsText(), 'stop');
      },
    });
    const result = await Effect.runPromise(run(model, 4));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe('Off by one');
    expect(calls).toHaveLength(1);
    expect(result.steps).toBe(1);
  });

  test('anthropic calls carry the thinking block-binding option', async () => {
    const calls: GenerateOptions[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push(options);
        return textResult(findingsText(), 'stop');
      },
    });
    const result = await Effect.runPromise(run(model, 4));
    expect(result.findings).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.providerOptions).toEqual(THINKING_BINDING);
  });

  test('haiku-4-5 gets no thinking option (adaptive thinking is rejected on 4.5 models)', async () => {
    const calls: GenerateOptions[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push(options);
        return textResult(findingsText(), 'stop');
      },
    });
    const result = await Effect.runPromise(run(model, 4, { models: { review: 'claude-haiku-4-5' } }));
    expect(result.findings).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.providerOptions).toBeUndefined();
  });

  test('sonnet-4-5 gets no thinking option (adaptive thinking is rejected on 4.5 models)', async () => {
    const calls: GenerateOptions[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push(options);
        return textResult(findingsText(), 'stop');
      },
    });
    const result = await Effect.runPromise(run(model, 4, { models: { review: 'claude-sonnet-4-5' } }));
    expect(result.findings).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.providerOptions).toBeUndefined();
  });

  test('an adaptive-capable model (sonnet-5-5) gets the thinking option', async () => {
    const calls: GenerateOptions[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push(options);
        return textResult(findingsText(), 'stop');
      },
    });
    const result = await Effect.runPromise(run(model, 4, { models: { review: 'claude-sonnet-5-5' } }));
    expect(result.findings).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.providerOptions).toEqual(THINKING_BINDING);
  });

  test('every follow-up call carries the thinking block-binding option', async () => {
    const calls: GenerateOptions[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push(options);
        const prompt = promptOf(options);
        if (prompt.includes(FINAL_FINDINGS_TURN)) return textResult(findingsText(), 'stop');
        if (options.toolChoice?.type === 'none') return textResult('partial answer', 'length');
        return toolCallResult(`call_${calls.length}`);
      },
    });
    const result = await Effect.runPromise(run(model, 3));
    expect(result.findings).toHaveLength(1);
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call.providerOptions).toEqual(THINKING_BINDING);
    }
  });

  test('non-anthropic providers get no anthropic thinking option', async () => {
    const calls: GenerateOptions[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push(options);
        return textResult(findingsText(), 'stop');
      },
    });
    const result = await Effect.runPromise(run(model, 4, { provider: 'openai', models: { review: 'gpt-5' } }));
    expect(result.findings).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.providerOptions).toBeUndefined();
  });

  test('step-limit exhaustion still produces findings from a tool-free final call', async () => {
    const calls: GenerateOptions[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push(options);
        const prompt = promptOf(options);
        if (prompt.includes(FINAL_FINDINGS_TURN)) return textResult(findingsText(), 'stop');
        if (options.toolChoice?.type === 'none') return textResult('partial answer', 'length');
        return toolCallResult(`call_${calls.length}`);
      },
    });

    const result = await Effect.runPromise(run(model, 3));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe(FINDING.ruleId);
    expect(result.steps).toBe(4);
    const finalCall = calls.find((call) => promptOf(call).includes(FINAL_FINDINGS_TURN));
    expect(finalCall?.toolChoice).toEqual({ type: 'none' });
    expect(finalCall?.tools).toEqual(calls[0]?.tools);
    expect(finalCall?.tools?.length).toBeGreaterThan(0);
    expect(calls.some((call) => call.toolChoice?.type !== 'none')).toBe(true);
    expect(result.usage.inputTokens).toBe(40);
  });

  test('final answer and repair re-ask keep the same tools as the loop calls', async () => {
    const calls: GenerateOptions[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push(options);
        const prompt = promptOf(options);
        if (prompt.includes('failed schema validation')) return textResult(findingsText(), 'stop');
        if (prompt.includes(FINAL_FINDINGS_TURN)) return textResult('{"elements":[{"title":"nope"}]}', 'stop');
        if (calls.length === 1) return toolCallResult('call_1');
        return textResult('partial answer', 'length');
      },
    });

    const result = await Effect.runPromise(run(model, 4));
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.ruleId).toBe(FINDING.ruleId);
    expect(calls).toHaveLength(4);

    // The tool set never changes mid-conversation: every model call sees the
    // same tools. `activeTools` is consumed by the AI SDK before the model
    // call (it filters `tools`), so identical `tools` on every call is the
    // observable proof that no call narrowed the tool set, and no model call
    // receives an `activeTools` value at all.
    const loopTools = calls[0]?.tools;
    expect(loopTools?.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.tools).toEqual(loopTools);
      expect((call as { activeTools?: unknown }).activeTools).toBeUndefined();
    }

    // Only `toolChoice: 'none'` makes a call tool-free. The loop calls keep
    // the SDK default (`auto`); the final answer and the repair re-ask set
    // it to none.
    const loopCalls = calls.filter((call) => !promptOf(call).includes(FINAL_FINDINGS_TURN));
    for (const call of loopCalls) expect(call.toolChoice).toEqual({ type: 'auto' });
    const finalCall = calls.find((call) => promptOf(call).includes(FINAL_FINDINGS_TURN));
    expect(finalCall?.toolChoice).toEqual({ type: 'none' });
    const repairCall = calls.find((call) => promptOf(call).includes('failed schema validation'));
    expect(repairCall?.toolChoice).toEqual({ type: 'none' });
    expect(repairCall?.tools).toEqual(loopTools);
  });

  test('repairs fenced JSON with a trailing comma without a second model call', async () => {
    const calls: GenerateOptions[] = [];
    const fenced = `\`\`\`json\n{"elements":[${JSON.stringify(FINDING)},]}\n\`\`\``;
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push(options);
        return textResult(fenced, 'stop');
      },
    });
    const result = await Effect.runPromise(run(model, 4));
    expect(calls).toHaveLength(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]?.title).toBe('Off by one');
  });

  test('schema repair re-ask keeps tool results gathered before the invalid answer', async () => {
    const calls: GenerateOptions[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push(options);
        const prompt = promptOf(options);
        if (prompt.includes('failed schema validation')) return textResult(findingsText(), 'stop');
        if (options.toolChoice?.type === 'none') return textResult('{"elements":[{"title":"nope"}]}', 'stop');
        return toolCallResult(`call_${calls.length}`);
      },
    });
    const result = await Effect.runPromise(run(model, 3));
    expect(result.findings).toHaveLength(1);
    const repairCall = calls.find((call) => promptOf(call).includes('failed schema validation'));
    if (!repairCall) throw new Error('missing repair call');
    expect(promptOf(repairCall)).toContain('export const a = 1');
    expect(repairCall.toolChoice).toEqual({ type: 'none' });
  });

  test('re-asks once with the validation error when local repair cannot fix the schema', async () => {
    const calls: GenerateOptions[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push(options);
        if (promptOf(options).includes('failed schema validation')) return textResult(findingsText(), 'stop');
        return textResult('{"elements":[{"title":"nope"}]}', 'stop');
      },
    });
    const result = await Effect.runPromise(run(model, 4));
    expect(calls).toHaveLength(2);
    const repairCall = calls[1];
    if (!repairCall) throw new Error('missing repair call');
    expect(promptOf(repairCall)).toContain('Validation error');
    expect(promptOf(repairCall)).toMatch(/ruleId/);
    expect(repairCall.toolChoice).toEqual({ type: 'none' });
    expect(result.findings).toHaveLength(1);
  });

  test('surfaces finish reason, step count, and raw text when repair also fails', async () => {
    const errors: string[] = [];
    const spy = (line: string) => {
      errors.push(line);
    };
    const original = console.error;
    console.error = spy;
    try {
      const model = new MockLanguageModelV3({
        doGenerate: async (options) => {
          if (promptOf(options).includes('failed schema validation')) {
            return textResult('NOT-JSON-SNIPPET still bad', 'stop');
          }
          return textResult('this is not json', 'stop');
        },
      });
      const error = await Effect.runPromise(run(model, 4).pipe(Effect.flip));
      expect(error._tag).toBe('ReviewOutputError');
      expect(error.message).toContain('model did not produce valid structured findings');
      expect(error.message).toContain('finishReason=stop');
      expect(error.message).toMatch(/steps=\d+/);
      expect(error.message).toContain('NOT-JSON-SNIPPET');
      expect(errors.some((line) => line.includes('NOT-JSON-SNIPPET') && line.includes('finishReason=stop'))).toBe(true);
    } finally {
      console.error = original;
    }
  });

  test('a provider error after the tool loop keeps the step count and finish reason', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        const prompt = promptOf(options);
        if (prompt.includes(FINAL_FINDINGS_TURN)) {
          throw Object.assign(new Error('connection reset by peer'), {
            statusCode: 503,
            responseBody: 'upstream timed out',
          });
        }
        if (options.toolChoice?.type === 'none') return textResult('partial answer', 'length');
        return toolCallResult(`call_${prompt.length}`);
      },
    });
    const error = await Effect.runPromise(run(model, 3).pipe(Effect.flip));
    expect(error._tag).toBe('ProviderError');
    expect(error.message).toContain('connection reset by peer');
    expect(error.message).toContain('status=503');
    expect(error.message).toContain('finishReason=length');
    expect(error.message).toContain('steps=3');
    expect(error.message).toContain('partial answer');
  });

  test('provider failures keep the underlying status and body', async () => {
    const model = new MockLanguageModelV3({
      doGenerate: async () => {
        const error = Object.assign(new Error('connection reset by peer'), {
          statusCode: 503,
          responseBody: 'upstream timed out',
        });
        throw error;
      },
    });
    const error = await Effect.runPromise(run(model, 2).pipe(Effect.flip));
    expect(error._tag).toBe('ProviderError');
    expect(error.message).toContain('connection reset by peer');
    expect(error.message).toContain('status=503');
    expect(error.message).toContain('upstream timed out');
    expect(error.message).not.toContain('structured findings');
  });
});

describe('verify', () => {
  test('anthropic verify calls carry the thinking block-binding option', async () => {
    const calls: GenerateOptions[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push(options);
        return textResult(JSON.stringify({ grounded: true, reason: 'matches the code' }), 'stop');
      },
    });
    const ai = AiSdkLive({ provider: 'anthropic', apiKey: 'test', languageModel: model }).pipe(
      Layer.provide(repoLayer)
    );
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* AiModel;
        return yield* svc.verify({
          task: 'verify',
          system: 'You are lupe.',
          candidate: FINDING,
          evidenceContext: 'export const a = 1;',
        });
      }).pipe(Effect.provide(ai))
    );
    expect(result.grounded).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.providerOptions).toEqual(THINKING_BINDING);
  });

  test('haiku-4-5 verify calls carry no thinking option (adaptive thinking is rejected on 4.5 models)', async () => {
    const calls: GenerateOptions[] = [];
    const model = new MockLanguageModelV3({
      doGenerate: async (options) => {
        calls.push(options);
        return textResult(JSON.stringify({ grounded: true, reason: 'matches the code' }), 'stop');
      },
    });
    const ai = AiSdkLive({
      provider: 'anthropic',
      apiKey: 'test',
      languageModel: model,
      models: { verify: 'claude-haiku-4-5' },
    }).pipe(Layer.provide(repoLayer));
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const svc = yield* AiModel;
        return yield* svc.verify({
          task: 'verify',
          system: 'You are lupe.',
          candidate: FINDING,
          evidenceContext: 'export const a = 1;',
        });
      }).pipe(Effect.provide(ai))
    );
    expect(result.grounded).toBe(true);
    expect(calls).toHaveLength(1);
    // No thinking option is passed, so the wire request carries no thinking
    // field and no thinking-binding beta header.
    expect(calls[0]?.providerOptions).toBeUndefined();
  });
});

describe('anthropic thinking binding wire format', () => {
  async function captureRequest(modelId: string, binding: ReturnType<typeof anthropicThinkingBinding>) {
    const captured: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : undefined;
      const headers = new Headers(request?.headers ?? init?.headers);
      const headerRecord: Record<string, string> = {};
      headers.forEach((value, key) => {
        headerRecord[key] = value;
      });
      const rawBody = request ? await request.text() : init?.body;
      captured.push({
        url: request?.url ?? String(input),
        headers: headerRecord,
        body: JSON.parse(String(rawBody ?? '{}')),
      });
      return new Response(
        JSON.stringify({
          id: 'msg_test',
          type: 'message',
          role: 'assistant',
          content: [{ type: 'text', text: 'review done' }],
          model: modelId,
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      );
    };
    const anthropic = createAnthropic({ apiKey: 'test', fetch: fetchMock as typeof fetch });
    const result = await generateText({
      model: anthropic(modelId),
      prompt: 'review this diff',
      providerOptions: binding,
    });
    expect(result.text).toBe('review done');
    expect(captured).toHaveLength(1);
    return captured[0] as {
      headers: Record<string, string>;
      body: { thinking?: { type?: string; block_binding?: { prefix_mismatch_behavior?: string } } };
    };
  }

  test('sends adaptive thinking with block_binding drop_block and the binding beta header', async () => {
    const request = await captureRequest('claude-sonnet-5-5', anthropicThinkingBinding('claude-sonnet-5-5'));
    expect(request.headers['anthropic-beta']).toContain('thinking-binding-controls-2026-08-01');
    expect(request.body.thinking?.type).toBe('adaptive');
    expect(request.body.thinking?.block_binding?.prefix_mismatch_behavior).toBe('drop_block');
  });

  test('haiku-4-5 sends no thinking field and no thinking-binding beta header', async () => {
    const request = await captureRequest('claude-haiku-4-5', anthropicThinkingBinding('claude-haiku-4-5'));
    expect(request.body.thinking).toBeUndefined();
    expect(request.headers['anthropic-beta'] ?? '').not.toContain('thinking-binding-controls-2026-08-01');
  });
});
