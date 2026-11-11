import { describe, expect, it } from 'vitest';
import { ScriptedProvider } from '../../../src/llm/fake/ScriptedProvider.js';
import { resolveModel, unlistedModelWarning } from '../../../src/llm/ProviderFactory.js';

describe('unlistedModelWarning', () => {
  const provider = new ScriptedProvider([], { models: ['qwen', 'llama'] });

  it('warns when an explicit model is not offered by the server', async () => {
    expect(await unlistedModelWarning(provider, 'ghost')).toContain('"ghost"');
  });

  it('is silent for listed models and for "auto"', async () => {
    expect(await unlistedModelWarning(provider, 'qwen')).toBeUndefined();
    expect(await unlistedModelWarning(provider, 'auto')).toBeUndefined();
  });
});

describe('resolveModel', () => {
  it('returns an explicit model unchanged, without asking the server', async () => {
    const provider = new ScriptedProvider([], { models: [] });
    expect(await resolveModel(provider, 'my-model')).toBe('my-model');
  });

  it('"auto" picks the first chat model and skips embedding models', async () => {
    const provider = new ScriptedProvider([], {
      models: ['text-embedding-nomic-embed-text-v1.5', 'qwen/qwen3-30b-a3b-2507'],
    });
    expect(await resolveModel(provider, 'auto')).toBe('qwen/qwen3-30b-a3b-2507');
  });

  it('"auto" with no chat model gives a no_models error', async () => {
    const provider = new ScriptedProvider([], { models: ['text-embedding-x'] });
    await expect(resolveModel(provider, 'auto')).rejects.toMatchObject({ kind: 'no_models' });
  });
});
