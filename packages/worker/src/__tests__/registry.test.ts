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
    expect(toolNames).toContain('claude-code');
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
});
