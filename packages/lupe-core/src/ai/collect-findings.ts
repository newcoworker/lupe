import {
  generateText,
  NoObjectGeneratedError,
  NoOutputGeneratedError,
  Output,
  stepCountIs,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from 'ai';

import type { Finding } from '../finding';
import { Finding as FindingSchema } from '../finding';
import { addUsage, EMPTY_USAGE, type TokenUsage } from '../review';
import { salvageFindings } from './salvage-findings';
import { anthropicCacheBreakpoint, anthropicThinkingBinding, toTokenUsage } from './usage';

/**
 * User turn appended when the tool loop stops without a final answer
 * (`finishReason !== 'stop'`, including step-limit exhaustion).
 */
export const FINAL_FINDINGS_TURN =
  'You have finished gathering context. Do not call tools. Emit the structured findings now from the diff and the tool results already in this conversation. If there are no real problems, return an empty list.';

const findingsOutput = Output.array({ element: FindingSchema });

interface Trace {
  steps: number;
  usage: TokenUsage;
  finishReason?: string;
  text?: string;
  /**
   * Assistant and tool messages gathered so far. `generateText` throws on a
   * schema failure before returning, and `NoObjectGeneratedError.response` is
   * only response metadata — it does not include these messages. The repair
   * re-ask reads this transcript instead.
   */
  messages: ModelMessage[];
}

/** Thrown when generation and the single repair pass both fail to yield findings. */
export class StructuredFindingsFailure extends Error {
  readonly finishReason?: string;
  readonly steps?: number;
  readonly text?: string;

  constructor(message: string, options: { cause?: unknown; finishReason?: string; steps?: number; text?: string }) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'StructuredFindingsFailure';
    if (options.finishReason !== undefined) this.finishReason = options.finishReason;
    if (options.steps !== undefined) this.steps = options.steps;
    if (options.text !== undefined) this.text = options.text;
  }
}

function isSchemaError(error: unknown): boolean {
  return NoObjectGeneratedError.isInstance(error) || NoOutputGeneratedError.isInstance(error);
}

function textOf(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const text = (error as { text?: unknown }).text;
  return typeof text === 'string' ? text : undefined;
}

function remember(trace: Trace, error: unknown): void {
  if (!error || typeof error !== 'object') return;
  const record = error as { finishReason?: unknown; cause?: unknown };
  if (typeof record.finishReason === 'string' && record.finishReason) trace.finishReason = record.finishReason;
  const text = textOf(error);
  if (text) trace.text = text;
  if (record.cause && record.cause !== error) {
    const cause = record.cause;
    if (typeof (cause as { finishReason?: unknown }).finishReason === 'string') {
      trace.finishReason = (cause as { finishReason: string }).finishReason;
    }
    const causeText = textOf(cause);
    if (causeText) trace.text = causeText;
  }
}

function responseMessages(error: unknown): readonly ModelMessage[] | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const messages = (error as { response?: { messages?: unknown } }).response?.messages;
  return Array.isArray(messages) ? (messages as ModelMessage[]) : undefined;
}

function conversation(base: readonly ModelMessage[], transcript: readonly ModelMessage[] | undefined): ModelMessage[] {
  return transcript && transcript.length > 0 ? [...base, ...transcript] : [...base];
}

/** Prefer the transcript captured at each step. Fall back to messages on the error when a provider includes them. */
function transcriptOf(trace: Trace, error: unknown): readonly ModelMessage[] | undefined {
  if (trace.messages.length > 0) return trace.messages;
  return responseMessages(error);
}

function repairTurn(validationError: string, raw: string | undefined): string {
  const body = raw && raw.trim() ? raw.slice(0, 4000) : '(empty)';
  return (
    `The previous response failed schema validation and was not accepted.\n` +
    `Validation error: ${validationError}\n` +
    `Raw response:\n${body}\n\n` +
    `Return only a valid findings object. Fix every validation error. Do not call tools.`
  );
}

export interface CollectFindingsInput {
  readonly model: LanguageModel;
  readonly system: string;
  readonly prompt: string;
  readonly tools: ToolSet;
  readonly maxSteps: number;
  readonly cacheable: boolean;
}

/**
 * Run the review tool loop, then guarantee a tool-free structured answer.
 *
 * The AI SDK parses `Output.array` only when `finishReason` is `stop`. A loop
 * that spends every step on tools therefore returns no findings and throws
 * `NoOutputGeneratedError` on `.output`. When that happens — or the model
 * stops for any other reason — one more call is made with tools disabled.
 * Invalid JSON gets one repair pass: local parse/fix, then a single re-ask
 * that includes the validation error.
 */
export async function collectFindings(
  input: CollectFindingsInput
): Promise<{ findings: readonly Finding[]; usage: TokenUsage; steps: number }> {
  const trace: Trace = { steps: 0, usage: EMPTY_USAGE, messages: [] };
  const hasTools = Object.keys(input.tools).length > 0;
  const base: ModelMessage[] = [
    input.cacheable
      ? { role: 'system', content: input.system, providerOptions: anthropicCacheBreakpoint() }
      : { role: 'system', content: input.system },
    { role: 'user', content: input.prompt },
  ];

  const onStepFinish = (step: {
    finishReason: string;
    text: string;
    usage: LanguageModelUsage;
    response?: { messages?: readonly ModelMessage[] };
  }): void => {
    trace.steps += 1;
    trace.finishReason = step.finishReason;
    if (step.text) trace.text = step.text;
    trace.usage = addUsage(trace.usage, toTokenUsage(step.usage));
    const messages = step.response?.messages;
    if (messages && messages.length > 0) trace.messages = [...messages];
  };

  const callModel = (messages: readonly ModelMessage[], mode: 'loop' | 'answer') => {
    return generateText({
      model: input.model,
      messages: [...messages],
      // Anthropic only: drop a thinking block whose signature no longer
      // matches its assistant prefix instead of failing the request with a
      // 400. The loop replays assistant messages (including thinking blocks)
      // into follow-up calls, so a replayed block can mismatch.
      providerOptions: input.cacheable ? anthropicThinkingBinding() : undefined,
      tools: hasTools ? input.tools : undefined,
      toolChoice: mode === 'answer' && hasTools ? 'none' : undefined,
      activeTools: mode === 'answer' && hasTools ? [] : undefined,
      stopWhen: [stepCountIs(mode === 'loop' ? input.maxSteps : 1)],
      prepareStep:
        mode === 'loop' && hasTools
          ? ({ stepNumber }) =>
              stepNumber >= input.maxSteps - 1 ? { toolChoice: 'none' as const, activeTools: [] } : undefined
          : undefined,
      output: findingsOutput,
      allowSystemInMessages: true,
      maxRetries: 2,
      onStepFinish,
    });
  };

  const done = (findings: readonly Finding[]) => ({
    findings,
    usage: trace.usage,
    steps: trace.steps,
  });

  const fail = (cause: unknown): never => {
    throw new StructuredFindingsFailure('model did not produce valid structured findings', {
      cause,
      finishReason: trace.finishReason,
      steps: trace.steps,
      text: trace.text,
    });
  };

  /** Keep finish reason, step count, and raw text on a provider error so liftError can print them. */
  const rethrow = (error: unknown): never => {
    if (error && typeof error === 'object') {
      const record = error as { finishReason?: string; steps?: number; text?: string };
      if (record.finishReason === undefined && trace.finishReason) record.finishReason = trace.finishReason;
      if (record.steps === undefined && trace.steps > 0) record.steps = trace.steps;
      if (record.text === undefined && trace.text) record.text = trace.text;
    }
    throw error;
  };

  /** One repair pass: fix the JSON locally, otherwise re-ask once with the validation error. */
  const repair = async (
    messages: readonly ModelMessage[],
    raw: string | undefined,
    validationError: string
  ): Promise<readonly Finding[] | undefined> => {
    const salvaged = salvageFindings(raw);
    if (salvaged.ok) return salvaged.findings;
    const errorText = salvaged.error || validationError;
    try {
      const repaired = await callModel([...messages, { role: 'user', content: repairTurn(errorText, raw) }], 'answer');
      if (repaired.finishReason === 'stop') return repaired.output as readonly Finding[];
      const again = salvageFindings(repaired.text);
      if (again.ok) return again.findings;
      trace.finishReason = repaired.finishReason;
      if (repaired.text) trace.text = repaired.text;
      return undefined;
    } catch (error) {
      remember(trace, error);
      if (!isSchemaError(error)) rethrow(error);
      const again = salvageFindings(textOf(error) ?? trace.text);
      return again.ok ? again.findings : undefined;
    }
  };

  let loop: Awaited<ReturnType<typeof callModel>>;
  try {
    loop = await callModel(base, 'loop');
  } catch (error) {
    remember(trace, error);
    if (!isSchemaError(error)) rethrow(error);
    const findings = await repair(
      conversation(base, transcriptOf(trace, error)),
      textOf(error) ?? trace.text,
      error instanceof Error ? error.message : 'invalid structured output'
    );
    if (findings) return done(findings);
    return fail(error);
  }

  if (loop.finishReason === 'stop') return done(loop.output as readonly Finding[]);

  const continued: ModelMessage[] = [
    ...base,
    ...loop.response.messages,
    { role: 'user', content: FINAL_FINDINGS_TURN },
  ];
  let finalTurn: Awaited<ReturnType<typeof callModel>>;
  try {
    finalTurn = await callModel(continued, 'answer');
  } catch (error) {
    remember(trace, error);
    if (!isSchemaError(error)) rethrow(error);
    // `continued` already holds the tool transcript. Do not append `trace.messages`:
    // the final call's onStepFinish replaces that with only this call's output.
    const findings = await repair(
      conversation(continued, responseMessages(error)),
      textOf(error) ?? trace.text,
      error instanceof Error ? error.message : 'invalid structured output'
    );
    if (findings) return done(findings);
    return fail(error);
  }

  if (finalTurn.finishReason === 'stop') return done(finalTurn.output as readonly Finding[]);

  trace.finishReason = finalTurn.finishReason;
  if (finalTurn.text) trace.text = finalTurn.text;
  const findings = await repair(continued, finalTurn.text, `finishReason=${finalTurn.finishReason}`);
  if (findings) return done(findings);
  return fail(new Error(`final structured call finished with ${finalTurn.finishReason}`));
}
