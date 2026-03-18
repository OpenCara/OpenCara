import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Consumption Tracking', () => {
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

  async function setupAgentWithLogs(
    logEntries: Array<{ tokens_used: number; created_at?: string }>,
  ) {
    const { user, apiKey } = await ctx.createUser();
    const userId = user.id as string;
    const agent = await ctx.createAgent(userId);
    const agentId = agent.id as string;

    const taskId = crypto.randomUUID();

    for (const entry of logEntries) {
      ctx.supabase.getTable('consumption_logs').push({
        id: crypto.randomUUID(),
        agent_id: agentId,
        review_task_id: taskId,
        tokens_used: entry.tokens_used,
        created_at: entry.created_at ?? new Date().toISOString(),
      });
    }

    return { user, apiKey, userId, agentId, taskId };
  }

  it('GET /api/consumption/:agentId returns correct totals', async () => {
    const { apiKey, agentId } = await setupAgentWithLogs([
      { tokens_used: 500 },
      { tokens_used: 300 },
    ]);

    const req = ctx.authedRequest(`/api/consumption/${agentId}`, apiKey);
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      agentId: string;
      totalTokens: number;
      totalReviews: number;
    };
    expect(body.agentId).toBe(agentId);
    expect(body.totalTokens).toBe(800);
    // Both logs share the same taskId, so totalReviews = 1 (unique task count)
    expect(body.totalReviews).toBe(1);
  });

  it('multiple logs with different tasks aggregate correctly', async () => {
    const { user, apiKey } = await ctx.createUser();
    const userId = user.id as string;
    const agent = await ctx.createAgent(userId);
    const agentId = agent.id as string;

    const taskId1 = crypto.randomUUID();
    const taskId2 = crypto.randomUUID();

    ctx.supabase.getTable('consumption_logs').push(
      {
        id: crypto.randomUUID(),
        agent_id: agentId,
        review_task_id: taskId1,
        tokens_used: 1000,
        created_at: new Date().toISOString(),
      },
      {
        id: crypto.randomUUID(),
        agent_id: agentId,
        review_task_id: taskId2,
        tokens_used: 2000,
        created_at: new Date().toISOString(),
      },
    );

    const req = ctx.authedRequest(`/api/consumption/${agentId}`, apiKey);
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      totalTokens: number;
      totalReviews: number;
    };
    expect(body.totalTokens).toBe(3000);
    expect(body.totalReviews).toBe(2);
  });

  it('period breakdowns correctly categorize by time', async () => {
    const { user, apiKey } = await ctx.createUser();
    const userId = user.id as string;
    const agent = await ctx.createAgent(userId);
    const agentId = agent.id as string;

    const now = Date.now();
    const MS_1H = 60 * 60 * 1000;
    const MS_2D = 2 * 24 * 60 * 60 * 1000;
    const MS_10D = 10 * 24 * 60 * 60 * 1000;
    const MS_60D = 60 * 24 * 60 * 60 * 1000;

    const taskRecent = crypto.randomUUID();
    const task2d = crypto.randomUUID();
    const task10d = crypto.randomUUID();
    const taskOld = crypto.randomUUID();

    // Recent (within 24h)
    ctx.supabase.getTable('consumption_logs').push({
      id: crypto.randomUUID(),
      agent_id: agentId,
      review_task_id: taskRecent,
      tokens_used: 100,
      created_at: new Date(now - MS_1H).toISOString(),
    });

    // 2 days ago (within 7d, not 24h)
    ctx.supabase.getTable('consumption_logs').push({
      id: crypto.randomUUID(),
      agent_id: agentId,
      review_task_id: task2d,
      tokens_used: 200,
      created_at: new Date(now - MS_2D).toISOString(),
    });

    // 10 days ago (within 30d, not 7d)
    ctx.supabase.getTable('consumption_logs').push({
      id: crypto.randomUUID(),
      agent_id: agentId,
      review_task_id: task10d,
      tokens_used: 300,
      created_at: new Date(now - MS_10D).toISOString(),
    });

    // 60 days ago (outside all periods)
    ctx.supabase.getTable('consumption_logs').push({
      id: crypto.randomUUID(),
      agent_id: agentId,
      review_task_id: taskOld,
      tokens_used: 400,
      created_at: new Date(now - MS_60D).toISOString(),
    });

    const req = ctx.authedRequest(`/api/consumption/${agentId}`, apiKey);
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      totalTokens: number;
      totalReviews: number;
      period: {
        last24h: { tokens: number; reviews: number };
        last7d: { tokens: number; reviews: number };
        last30d: { tokens: number; reviews: number };
      };
    };

    expect(body.totalTokens).toBe(1000);
    expect(body.totalReviews).toBe(4);

    // 24h: only the recent one
    expect(body.period.last24h.tokens).toBe(100);
    expect(body.period.last24h.reviews).toBe(1);

    // 7d: recent + 2d ago
    expect(body.period.last7d.tokens).toBe(300);
    expect(body.period.last7d.reviews).toBe(2);

    // 30d: recent + 2d ago + 10d ago
    expect(body.period.last30d.tokens).toBe(600);
    expect(body.period.last30d.reviews).toBe(3);
  });

  it('agent not found returns 404', async () => {
    const { apiKey } = await ctx.createUser();

    const req = ctx.authedRequest(`/api/consumption/${crypto.randomUUID()}`, apiKey);
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(404);
  });

  it("different user's agent returns 404", async () => {
    // Create the agent owner
    const { user: owner } = await ctx.createUser({ name: 'agent-owner' });
    const agent = await ctx.createAgent(owner.id as string);
    const agentId = agent.id as string;

    // Create a different user who tries to access the consumption
    const { apiKey: otherApiKey } = await ctx.createUser({
      name: 'other-user',
      github_id: 777777,
    });

    const req = ctx.authedRequest(`/api/consumption/${agentId}`, otherApiKey);
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(404);
  });
});
