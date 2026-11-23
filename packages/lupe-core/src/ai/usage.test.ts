import type { LanguageModelUsage } from 'ai';
import { describe, expect, test } from 'vitest';

import { anthropicCacheBreakpoint, anthropicThinkingBinding, toTokenUsage } from './usage';

describe('toTokenUsage', () => {
  test('maps input/output and cache details', () => {
    const usage = {
      inputTokens: 1000,
      outputTokens: 200,
      totalTokens: 1200,
      inputTokenDetails: { noCacheTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 100 },
    } as unknown as LanguageModelUsage;
    expect(toTokenUsage(usage)).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      cacheReadTokens: 800,
      cacheCreationTokens: 100,
    });
  });

  test('falls back to deprecated cachedInputTokens', () => {
    const usage = {
      inputTokens: 50,
      outputTokens: 10,
      cachedInputTokens: 40,
    } as unknown as LanguageModelUsage;
    expect(toTokenUsage(usage).cacheReadTokens).toBe(40);
  });

  test('handles undefined usage', () => {
    expect(toTokenUsage(undefined)).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
    });
  });

  test('anthropic cache breakpoint shape', () => {
    expect(anthropicCacheBreakpoint()).toEqual({ anthropic: { cacheControl: { type: 'ephemeral' } } });
  });

  test('anthropic thinking binding pins adaptive thinking and drops a mismatched block', () => {
    expect(anthropicThinkingBinding()).toEqual({
      anthropic: {
        thinking: { type: 'adaptive', blockBinding: { prefixMismatchBehavior: 'drop_block' } },
      },
    });
  });
});
