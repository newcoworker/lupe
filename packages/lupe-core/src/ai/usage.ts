import type { LanguageModelUsage } from 'ai';

import type { TokenUsage } from '../review';

/** Map the AI SDK's unified usage onto lupe's TokenUsage (cache-aware). */
export function toTokenUsage(usage: LanguageModelUsage | undefined): TokenUsage {
  const details = usage?.inputTokenDetails;
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    cacheReadTokens: details?.cacheReadTokens ?? usage?.cachedInputTokens ?? 0,
    cacheCreationTokens: details?.cacheWriteTokens ?? 0,
  };
}

/** Provider options that mark an Anthropic prompt-cache breakpoint on a message. */
export function anthropicCacheBreakpoint(): { anthropic: { cacheControl: { type: 'ephemeral' } } } {
  return { anthropic: { cacheControl: { type: 'ephemeral' } } };
}

/**
 * Whether an Anthropic model supports adaptive thinking (`thinking.type:
 * 'adaptive'`). Per Anthropic's docs, adaptive thinking is supported on
 * Claude 4.6 and later models and Claude Mythos Preview; Claude 4.5 and
 * earlier models support only legacy manual (extended) thinking and reject
 * `adaptive` with a 400. See the per-model table at
 * https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
 * and the primer at https://platform.claude.com/docs/en/claude_api_primer
 * ("Adaptive thinking is supported on Claude 4.6 and later models and Claude
 * Mythos Preview"). Adaptive-capable: Opus 4.6, Sonnet 4.6, Opus 4.7,
 * Opus 4.8, and every Claude 5 model (Opus 5, Sonnet 5, Haiku 5, Fable 5,
 * Mythos 5, and their 5.1/5.2/5.5 variants), plus Claude Mythos Preview.
 * Not adaptive-capable: Opus 4.5, Sonnet 4.5, Haiku 4.5, and earlier
 * Claude 4 models (they reject `"adaptive"` with a 400).
 *
 * Unknown or new model ids default to false (fail safe): the thinking option
 * is omitted entirely, leaving behavior unchanged. A future model version
 * that follows the documented "4.6 and later" rule (major version above 4,
 * or 4 with a minor of 6 or more) is treated as adaptive-capable.
 */
export function supportsAdaptiveThinking(modelId: string | undefined): boolean {
  if (!modelId) return false;
  if (modelId === 'claude-mythos-preview' || modelId.startsWith('claude-mythos-preview-')) return true;
  const match = /^claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:-(\d+))?/.exec(modelId);
  if (!match) return false;
  const major = Number(match[2]);
  const minor = match[3] === undefined ? undefined : Number(match[3]);
  if (major > 4) return true;
  if (major === 4) return minor !== undefined && minor >= 6;
  return false;
}

/**
 * Provider options that tell Anthropic to drop a thinking block whose signature
 * no longer matches its assistant prefix instead of failing the request with
 * a 400. `type: 'adaptive'` pins the thinking mode, and `blockBinding`
 * drops a mismatched block instead of failing. The Anthropic provider adds the
 * `thinking-binding-controls-2026-08-01` beta header automatically when this
 * option is present.
 *
 * Needed because the review loop replays assistant messages (including
 * thinking blocks) into follow-up calls; a replayed block whose prefix no
 * longer matches otherwise fails the whole review with an invalid thinking
 * signature error.
 *
 * Gated by model capability: only models Anthropic documents as supporting
 * adaptive thinking get the option (see supportsAdaptiveThinking). For every
 * other model the option is omitted entirely, so behavior is unchanged.
 * Callers must pass the model id of the model actually used for the call.
 */
export function anthropicThinkingBinding(modelId: string | undefined):
  | {
      anthropic: {
        thinking: { type: 'adaptive'; blockBinding: { prefixMismatchBehavior: 'drop_block' } };
      };
    }
  | undefined {
  if (!supportsAdaptiveThinking(modelId)) return undefined;
  return {
    anthropic: {
      thinking: { type: 'adaptive', blockBinding: { prefixMismatchBehavior: 'drop_block' } },
    },
  };
}
