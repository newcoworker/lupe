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
 */
export function anthropicThinkingBinding(): {
  anthropic: {
    thinking: { type: 'adaptive'; blockBinding: { prefixMismatchBehavior: 'drop_block' } };
  };
} {
  return {
    anthropic: {
      thinking: { type: 'adaptive', blockBinding: { prefixMismatchBehavior: 'drop_block' } },
    },
  };
}
