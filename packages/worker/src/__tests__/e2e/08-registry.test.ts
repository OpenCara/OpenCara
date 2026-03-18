import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Registry (GET /api/registry)', () => {
  let ctx: E2EContext;

  beforeEach(() => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(
      ctx.supabase.client as ReturnType<typeof createSupabaseClient>,
    );
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  it('GET /api/registry returns 200 with models and tools', async () => {
    const req = new Request('https://api.opencara.dev/api/registry', { method: 'GET' });
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { models: unknown[]; tools: unknown[] };
    expect(body).toHaveProperty('models');
    expect(body).toHaveProperty('tools');
    expect(body.models.length).toBeGreaterThan(0);
    expect(body.tools.length).toBeGreaterThan(0);
  });

  it('no auth required — returns 200 without Bearer token', async () => {
    const req = new Request('https://api.opencara.dev/api/registry', { method: 'GET' });
    // No Authorization header
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(200);
  });

  it('response has expected shape (models array of objects, tools array of objects)', async () => {
    const req = new Request('https://api.opencara.dev/api/registry', { method: 'GET' });
    const res = await ctx.workerFetch(req);
    const body = (await res.json()) as {
      models: Array<{
        name: string;
        displayName: string;
        tools: string[];
        defaultReputation: number;
      }>;
      tools: Array<{ name: string; displayName: string; binary: string; commandTemplate: string }>;
    };

    // Each model should have name, displayName, tools array, and defaultReputation
    for (const model of body.models) {
      expect(model).toHaveProperty('name');
      expect(model).toHaveProperty('displayName');
      expect(model).toHaveProperty('tools');
      expect(Array.isArray(model.tools)).toBe(true);
      expect(model).toHaveProperty('defaultReputation');
      expect(typeof model.defaultReputation).toBe('number');
      expect(model.defaultReputation).toBeGreaterThanOrEqual(0);
      expect(model.defaultReputation).toBeLessThanOrEqual(1);
    }

    // Each tool should have name, displayName, binary, and commandTemplate
    for (const tool of body.tools) {
      expect(tool).toHaveProperty('name');
      expect(tool).toHaveProperty('displayName');
      expect(tool).toHaveProperty('binary');
      expect(tool).toHaveProperty('commandTemplate');
    }
  });
});
