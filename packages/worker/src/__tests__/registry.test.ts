import { describe, it, expect } from 'vitest';
import { handleGetRegistry } from '../handlers/registry.js';

describe('handleGetRegistry', () => {
  it('returns 200 with tools and models', async () => {
    const response = handleGetRegistry();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.tools).toBeDefined();
    expect(body.models).toBeDefined();
    expect(Array.isArray(body.tools)).toBe(true);
    expect(Array.isArray(body.models)).toBe(true);
  });

  it('includes expected tools', async () => {
    const { tools } = await handleGetRegistry().json();
    const toolNames = tools.map((t: { name: string }) => t.name);
    expect(toolNames).toContain('claude');
    expect(toolNames).toContain('qwen');
    expect(toolNames).toContain('gemini');
    expect(toolNames).toContain('codex');
  });

  it('includes expected models', async () => {
    const { models } = await handleGetRegistry().json();
    const modelNames = models.map((m: { name: string }) => m.name);
    expect(modelNames).toContain('claude-opus-4-6');
    expect(modelNames).toContain('qwen3.5-plus');
    expect(modelNames).toContain('glm-5');
  });

  it('models reference valid tool names', async () => {
    const { tools, models } = await handleGetRegistry().json();
    const toolNames = new Set(tools.map((t: { name: string }) => t.name));
    for (const model of models) {
      for (const toolRef of model.tools) {
        expect(toolNames.has(toolRef)).toBe(true);
      }
    }
  });

  it('tools have required fields', async () => {
    const { tools } = await handleGetRegistry().json();
    for (const tool of tools) {
      expect(typeof tool.name).toBe('string');
      expect(typeof tool.displayName).toBe('string');
      expect(typeof tool.binary).toBe('string');
      expect(typeof tool.commandTemplate).toBe('string');
      expect(typeof tool.tokenParser).toBe('string');
    }
  });

  it('each model has a defaultReputation between 0 and 1', async () => {
    const { models } = await handleGetRegistry().json();
    for (const model of models) {
      expect(typeof model.defaultReputation).toBe('number');
      expect(model.defaultReputation).toBeGreaterThanOrEqual(0);
      expect(model.defaultReputation).toBeLessThanOrEqual(1);
    }
  });

  it('returns expected default reputation values for known models', async () => {
    const { models } = await handleGetRegistry().json();
    const byName = Object.fromEntries(
      models.map((m: { name: string; defaultReputation: number }) => [m.name, m.defaultReputation]),
    );
    expect(byName['claude-opus-4-6']).toBe(0.8);
    expect(byName['claude-sonnet-4-6']).toBe(0.7);
    expect(byName['gemini-2.5-pro']).toBe(0.7);
    expect(byName['qwen3.5-plus']).toBe(0.6);
    expect(byName['glm-5']).toBe(0.5);
    expect(byName['kimi-k2.5']).toBe(0.5);
    expect(byName['minimax-m2.5']).toBe(0.5);
  });
});
