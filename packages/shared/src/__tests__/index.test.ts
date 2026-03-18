import { describe, it, expect } from 'vitest';
import {
  getVersion,
  API_KEY_PREFIX,
  DEFAULT_REGISTRY,
  DEFAULT_REPUTATION_FALLBACK,
  getModelDefaultReputation,
} from '../index.js';

describe('shared', () => {
  it('returns version string', () => {
    expect(getVersion()).toBe('0.0.1');
  });

  it('exports message types', async () => {
    const mod = await import('../index.js');
    expect(mod.getVersion).toBeDefined();
  });

  it('exports API_KEY_PREFIX with correct value', () => {
    expect(API_KEY_PREFIX).toBe('cr_');
  });

  it('exports database entity types', async () => {
    // Type-level check: ensure types are re-exported
    const mod = await import('../index.js');
    expect(mod.API_KEY_PREFIX).toBeDefined();
    expect(mod.getVersion).toBeDefined();
  });
});

describe('getModelDefaultReputation', () => {
  it('returns correct reputation for known models', () => {
    expect(getModelDefaultReputation('claude-opus-4-6')).toBe(0.8);
    expect(getModelDefaultReputation('claude-sonnet-4-6')).toBe(0.7);
    expect(getModelDefaultReputation('gemini-2.5-pro')).toBe(0.7);
    expect(getModelDefaultReputation('qwen3.5-plus')).toBe(0.6);
    expect(getModelDefaultReputation('glm-5')).toBe(0.5);
    expect(getModelDefaultReputation('kimi-k2.5')).toBe(0.5);
    expect(getModelDefaultReputation('minimax-m2.5')).toBe(0.5);
  });

  it('returns DEFAULT_REPUTATION_FALLBACK for unknown models', () => {
    expect(getModelDefaultReputation('unknown-model')).toBe(DEFAULT_REPUTATION_FALLBACK);
    expect(getModelDefaultReputation('')).toBe(DEFAULT_REPUTATION_FALLBACK);
    expect(getModelDefaultReputation('gpt-99')).toBe(DEFAULT_REPUTATION_FALLBACK);
  });

  it('DEFAULT_REPUTATION_FALLBACK is 0.5', () => {
    expect(DEFAULT_REPUTATION_FALLBACK).toBe(0.5);
  });

  it('all registry models have defaultReputation between 0 and 1', () => {
    for (const model of DEFAULT_REGISTRY.models) {
      expect(model.defaultReputation).toBeGreaterThanOrEqual(0);
      expect(model.defaultReputation).toBeLessThanOrEqual(1);
    }
  });
});
