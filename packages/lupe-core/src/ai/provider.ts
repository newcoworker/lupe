import { createAmazonBedrock } from '@ai-sdk/amazon-bedrock';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createGateway } from '@ai-sdk/gateway';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import type { LanguageModel } from 'ai';

import type { ReviewTask } from './model';

/** API-key (and gateway) providers the AI SDK layer can resolve directly.
 * The local-CLI providers (`claude-cli`, `codex-cli`) are separate AiModel
 * Layers contributed by the CLI package. */
export type ApiProviderId = 'anthropic' | 'openai' | 'google' | 'bedrock' | 'openai-compatible' | 'gateway';

export interface LupeAiConfig {
  readonly provider: ApiProviderId;
  /** Falls back to the provider's conventional env var when omitted. */
  readonly apiKey?: string;
  /** For `openai-compatible` (required), or to override a provider endpoint. */
  readonly baseURL?: string;
  readonly headers?: Record<string, string>;
  /** Per-task model id overrides (e.g. `{ review: "claude-opus-4-8" }`). */
  readonly models?: Partial<Record<ReviewTask, string>>;
  /** AWS region for `bedrock`. */
  readonly region?: string;
  /** Display name for `openai-compatible`. */
  readonly name?: string;
  /**
   * Disable the agent's read-only repo tools (readFile/listDir/grep). Set when the
   * checkout may contain untrusted code (pull_request_target) so the model cannot
   * read the working tree. The prompt should also carry `hasTools: false`.
   */
  readonly disableTools?: boolean;
  /**
   * Use this model for every task instead of constructing the provider client.
   * Tests inject a mock; production leaves it unset.
   */
  readonly languageModel?: LanguageModel;
}

export interface ModelHandle {
  readonly model: LanguageModel;
  readonly modelId: string;
}

export type ModelResolver = (task: ReviewTask) => ModelHandle;

/** Default task→model routing. Only Anthropic (the recommended default) ships
 * hard defaults; other providers must specify `models` per task. */
const ANTHROPIC_DEFAULTS: Record<ReviewTask, string> = {
  triage: 'claude-haiku-4-5',
  review: 'claude-opus-4-8',
  verify: 'claude-sonnet-4-6',
  deep: 'claude-fable-5',
};

export function defaultModelId(provider: ApiProviderId, task: ReviewTask): string | undefined {
  return provider === 'anthropic' ? ANTHROPIC_DEFAULTS[task] : undefined;
}

export function resolveTaskModelId(config: LupeAiConfig, task: ReviewTask): string {
  const id = config.models?.[task] ?? defaultModelId(config.provider, task);
  if (!id) {
    throw new Error(
      `No model configured for task "${task}" with provider "${config.provider}". ` +
        `Set models.${task} in your lupe config.`
    );
  }
  return id;
}

type ModelFactory = (modelId: string) => LanguageModel;

function buildProvider(config: LupeAiConfig): ModelFactory {
  switch (config.provider) {
    case 'anthropic': {
      const p = createAnthropic({ apiKey: config.apiKey, baseURL: config.baseURL, headers: config.headers });
      return (id) => p(id);
    }
    case 'openai': {
      const p = createOpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, headers: config.headers });
      return (id) => p(id);
    }
    case 'google': {
      const p = createGoogleGenerativeAI({
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        headers: config.headers,
      });
      return (id) => p(id);
    }
    case 'openai-compatible': {
      if (!config.baseURL) {
        throw new Error(`provider "openai-compatible" requires a baseURL`);
      }
      const p = createOpenAICompatible({
        name: config.name ?? 'openai-compatible',
        baseURL: config.baseURL,
        apiKey: config.apiKey,
        headers: config.headers,
      });
      return (id) => p(id);
    }
    case 'gateway': {
      const p = createGateway({ apiKey: config.apiKey, baseURL: config.baseURL });
      return (id) => p(id);
    }
    case 'bedrock': {
      const p = createAmazonBedrock({ region: config.region });
      return (id) => p(id);
    }
  }
}

/** Build a task→model resolver for the configured provider. */
export function createModelResolver(config: LupeAiConfig): ModelResolver {
  if (config.languageModel) {
    const model = config.languageModel;
    return (task) => ({ model, modelId: resolveTaskModelId(config, task) });
  }
  const factory = buildProvider(config);
  return (task) => {
    const modelId = resolveTaskModelId(config, task);
    return { model: factory(modelId), modelId };
  };
}
