import type { LanguageModelUsage } from 'ai';
import { describe, expect, test } from 'vitest';

import { anthropicCacheBreakpoint, anthropicThinkingBinding, supportsAdaptiveThinking, toTokenUsage } from './usage';

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
    expect(anthropicThinkingBinding('claude-sonnet-5-5')).toEqual({
      anthropic: {
        thinking: { type: 'adaptive', blockBinding: { prefixMismatchBehavior: 'drop_block' } },
      },
    });
  });

  test('anthropic thinking binding is omitted for models without adaptive thinking', () => {
    expect(anthropicThinkingBinding('claude-haiku-4-5')).toBeUndefined();
    expect(anthropicThinkingBinding('claude-sonnet-4-5')).toBeUndefined();
    expect(anthropicThinkingBinding('claude-opus-4-5')).toBeUndefined();
    expect(anthropicThinkingBinding('claude-opus-4-5-20251101')).toBeUndefined();
    expect(anthropicThinkingBinding(undefined)).toBeUndefined();
    expect(anthropicThinkingBinding('gpt-5')).toBeUndefined();
  });

  test('supportsAdaptiveThinking follows the Anthropic docs (4.6 and later, plus Mythos Preview)', () => {
    // Adaptive-capable per the docs.
    for (const modelId of [
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-haiku-5',
      'claude-fable-5',
      'claude-mythos-5',
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-haiku-5-5',
      'claude-fable-5-1',
      'claude-fable-5-2',
      'claude-mythos-5-1',
      'claude-mythos-5-2',
      'claude-mythos-preview',
    ]) {
      expect(supportsAdaptiveThinking(modelId)).toBe(true);
    }
    // Legacy manual thinking only: adaptive is rejected with a 400.
    for (const modelId of [
      'claude-opus-4-5',
      'claude-sonnet-4-5',
      'claude-haiku-4-5',
      'claude-sonnet-4-5-20250929',
      'claude-haiku-4-5-20251001',
      'claude-opus-4-5-20251101',
      // Date-stamped major-only releases (Claude 4.0): the 8-digit date is
      // not a minor version, so these are not adaptive-capable.
      'claude-sonnet-4-20250514',
      'claude-opus-4-20250514',
      'claude-haiku-4-20250514',
    ]) {
      expect(supportsAdaptiveThinking(modelId)).toBe(false);
    }
    // Unknown ids fail safe (omitted).
    expect(supportsAdaptiveThinking(undefined)).toBe(false);
    expect(supportsAdaptiveThinking('')).toBe(false);
    expect(supportsAdaptiveThinking('gpt-5')).toBe(false);
    expect(supportsAdaptiveThinking('claude-opus-3')).toBe(false);
  });
});
