import type { LanguageModel } from 'ai';
import { describe, expect, test } from 'vitest';

import { createModelResolver, defaultModelId, resolveTaskModelId } from './provider';

describe('model routing', () => {
  test('anthropic ships task defaults', () => {
    expect(defaultModelId('anthropic', 'triage')).toBe('claude-haiku-4-5');
    expect(defaultModelId('anthropic', 'review')).toBe('claude-opus-4-8');
    expect(defaultModelId('anthropic', 'verify')).toBe('claude-sonnet-4-6');
    expect(defaultModelId('anthropic', 'deep')).toBe('claude-fable-5');
  });

  test('non-anthropic providers have no hard defaults', () => {
    expect(defaultModelId('openai', 'review')).toBeUndefined();
  });

  test('config overrides win over defaults', () => {
    const cfg = { provider: 'anthropic', models: { review: 'claude-opus-4-8-custom' } } as const;
    expect(resolveTaskModelId(cfg, 'review')).toBe('claude-opus-4-8-custom');
    expect(resolveTaskModelId(cfg, 'triage')).toBe('claude-haiku-4-5');
  });

  test('throws a helpful error when a non-anthropic task has no model', () => {
    expect(() => resolveTaskModelId({ provider: 'openai' }, 'review')).toThrow(/No model configured/);
  });

  test('createModelResolver builds a model handle (anthropic, no network)', () => {
    const resolve = createModelResolver({ provider: 'anthropic', apiKey: 'test-key' });
    const handle = resolve('review');
    expect(handle.modelId).toBe('claude-opus-4-8');
    expect(handle.model).toBeDefined();
  });

  test('openai-compatible without baseURL fails fast', () => {
    expect(() => createModelResolver({ provider: 'openai-compatible', apiKey: 'x' })).toThrow(/baseURL/);
  });

  test('languageModel override skips provider construction', () => {
    const model = { specificationVersion: 'v3', provider: 'mock', modelId: 'm' } as LanguageModel;
    const resolve = createModelResolver({
      provider: 'openai-compatible',
      languageModel: model,
      models: { review: 'custom-model' },
    });
    expect(resolve('review')).toEqual({ model, modelId: 'custom-model' });
  });
});
