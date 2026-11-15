import { generateText, NoObjectGeneratedError, NoOutputGeneratedError, Output } from 'ai';
import { Effect, Layer } from 'effect';
import { z } from 'zod';

import { ProviderError, RateLimitError, RefusalError, ReviewOutputError } from '../errors';
import { RepoSource } from '../ports';
import { collectFindings, StructuredFindingsFailure } from './collect-findings';
import { formatFailureDetail } from './failure-detail';
import {
  AiModel,
  type AiError,
  type AiModelService,
  type GenerateFindingsInput,
  type GenerateFindingsResult,
  type VerifyInput,
  type VerifyResult,
} from './model';
import { createModelResolver, type LupeAiConfig } from './provider';
import { buildRepoTools } from './tools';
import { anthropicCacheBreakpoint, toTokenUsage } from './usage';

const DEFAULT_MAX_STEPS = 12;

function isStructuredFailure(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name ?? '';
  return (
    error instanceof StructuredFindingsFailure ||
    NoObjectGeneratedError.isInstance(error) ||
    NoOutputGeneratedError.isInstance(error) ||
    /NoObjectGenerated|NoOutputGenerated|StructuredFindingsFailure/.test(name)
  );
}

function ownMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Public message for a structured-output failure, including the real cause. */
function structuredMessage(error: unknown): string {
  const detail = formatFailureDetail(error);
  const own = ownMessage(error);
  const parts: string[] = [];
  if (own && own !== 'model did not produce valid structured findings' && !detail.includes(own)) parts.push(own);
  if (detail) parts.push(detail);
  const extra = parts.join('; ');
  return extra
    ? `model did not produce valid structured findings (${extra})`
    : 'model did not produce valid structured findings';
}

function withDetail(error: unknown): string {
  const own = ownMessage(error);
  const detail = formatFailureDetail(error);
  if (!detail || own.includes(detail)) return own;
  return `${own} (${detail})`;
}

/**
 * Map an AI SDK / network failure onto a tagged lupe error. The message (what
 * the Action prints) and the log line both include the underlying cause:
 * finish reason, step count, provider status/body, and a raw-text snippet.
 */
function liftError(error: unknown, provider: string): AiError {
  if (isStructuredFailure(error)) {
    const message = structuredMessage(error);
    console.error(`lupe: ${provider}: ${message}`);
    return new ReviewOutputError({ message, cause: error });
  }
  const message = withDetail(error);
  console.error(`lupe: ${provider}: ${message}`);
  const name = (error as { name?: string } | null)?.name ?? '';
  const status =
    (error as { statusCode?: number; status?: number } | null)?.statusCode ??
    (error as { status?: number } | null)?.status;
  if (status === 429 || /rate.?limit/i.test(message)) {
    return new RateLimitError({ message, provider });
  }
  if (/refus/i.test(name) || /\brefus(e|al|ed)\b/i.test(message)) {
    return new RefusalError({ message });
  }
  return new ProviderError({ message, provider, cause: error });
}

const VerifySchema = z.object({
  grounded: z.boolean(),
  reason: z.string(),
  suggestionValid: z.boolean().optional(),
  impactConfirmed: z.boolean().optional(),
});

/**
 * The v1 concrete AiModel Layer — wraps the Vercel AI SDK. The engine depends
 * only on the AiModel tag, so adopting @effect/ai later is a Layer swap.
 *
 * Requires RepoSource (for the agent's read-only tools).
 */
export function AiSdkLive(config: LupeAiConfig): Layer.Layer<AiModel, never, RepoSource> {
  return Layer.effect(
    AiModel,
    Effect.gen(function* () {
      const repo = yield* RepoSource;
      // When the checkout is untrusted (pull_request_target), run tool-less so the
      // model can't read the working tree via readFile/grep.
      const tools = config.disableTools ? {} : buildRepoTools(repo);
      const resolveModel = createModelResolver(config);
      const cacheable = config.provider === 'anthropic';

      const systemMessage = (content: string) =>
        cacheable
          ? { role: 'system' as const, content, providerOptions: anthropicCacheBreakpoint() }
          : { role: 'system' as const, content };

      const generateFindings = (input: GenerateFindingsInput): Effect.Effect<GenerateFindingsResult, AiError> =>
        Effect.tryPromise({
          try: async () => {
            const { model, modelId } = resolveModel(input.task);
            const collected = await collectFindings({
              model,
              system: input.system,
              prompt: input.prompt,
              tools,
              maxSteps: input.maxSteps ?? DEFAULT_MAX_STEPS,
              cacheable,
            });
            return { ...collected, model: modelId };
          },
          catch: (error) => liftError(error, config.provider),
        });

      const verify = (input: VerifyInput): Effect.Effect<VerifyResult, AiError> =>
        Effect.tryPromise({
          try: async () => {
            const { model, modelId } = resolveModel(input.task);
            const candidate = input.candidate;
            const result = await generateText({
              model,
              messages: [
                systemMessage(input.system),
                {
                  role: 'user',
                  content:
                    `Finding under review:\n` +
                    `- rule: ${candidate.ruleId}\n` +
                    `- title: ${candidate.title}\n` +
                    `- location: ${candidate.path}:${candidate.startLine}\n` +
                    `- claim: ${candidate.message}\n` +
                    (candidate.suggestion !== undefined
                      ? `- proposed suggestion (replacement for the anchored range):\n${candidate.suggestion}\n`
                      : '') +
                    `\nCited code context:\n${input.evidenceContext}\n\n` +
                    `Decide whether this finding is correct AND grounded in the cited code. ` +
                    `Set grounded=false if it is speculative, already handled, or not supported by the code. ` +
                    `Set impactConfirmed=false if the mechanism is real but the claimed impact/severity depends on a precondition not visible here (an off-context caller, an external contract, or unproven attacker-/tenant-controllability).` +
                    (candidate.suggestion !== undefined
                      ? ` Also set suggestionValid=false if the proposed suggestion would not correctly fix the problem (e.g. a no-op or code that does not compile).`
                      : ''),
                },
              ],
              output: Output.object({ schema: VerifySchema }),
              allowSystemInMessages: true,
              maxRetries: 2,
            });
            const out = result.output;
            return {
              grounded: out.grounded,
              reason: out.reason,
              suggestionValid: out.suggestionValid,
              impactConfirmed: out.impactConfirmed,
              usage: toTokenUsage(result.totalUsage),
              model: modelId,
            };
          },
          catch: (error) => liftError(error, config.provider),
        });

      const service: AiModelService = { generateFindings, verify };
      return service;
    })
  );
}
