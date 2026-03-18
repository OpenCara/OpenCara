import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Consumption Tracking (Deprecated)', () => {
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

  it('GET /api/consumption/:agentId returns 410 Gone', async () => {
    const { user, apiKey } = await ctx.createUser();
    const agent = await ctx.createAgent(user.id as string);
    const agentId = agent.id as string;

    const req = ctx.authedRequest(`/api/consumption/${agentId}`, apiKey);
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(410);

    const body = (await res.json()) as { error: string };
    expect(body.error).toContain('removed');
  });

  it('returns 410 regardless of agent existence', async () => {
    const { apiKey } = await ctx.createUser();

    const req = ctx.authedRequest(`/api/consumption/${crypto.randomUUID()}`, apiKey);
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(410);
  });
});
