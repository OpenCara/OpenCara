import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Stats Endpoints', () => {
  let ctx: E2EContext;

  beforeEach(() => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(ctx.supabase.client as ReturnType<typeof createSupabaseClient>);
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  /** Create a user + agent and populate review_results and ratings for tier calculation. */
  async function createAgentWithReviews(
    completedCount: number,
    thumbsUp: number,
    thumbsDown: number,
    overrides?: { name?: string; github_id?: number },
  ) {
    const { user, apiKey } = await ctx.createUser({
      name: overrides?.name ?? 'stats-user',
      github_id: overrides?.github_id ?? Math.floor(Math.random() * 1000000),
    });
    const userId = user.id as string;

    const agent = await ctx.createAgent(userId, {
      model: 'test-model',
      tool: 'test-tool',
      status: 'online',
    });
    const agentId = agent.id as string;

    // Create completed review results
    const resultIds: string[] = [];
    for (let i = 0; i < completedCount; i++) {
      const resultId = crypto.randomUUID();
      ctx.supabase.getTable('review_results').push({
        id: resultId,
        review_task_id: crypto.randomUUID(),
        agent_id: agentId,
        status: 'completed',
        review_text: `Review ${i}`,
        verdict: 'approve',
        created_at: new Date().toISOString(),
      });
      resultIds.push(resultId);
    }

    // Create ratings (distribute among the first result IDs)
    let raterIdCounter = 1;
    for (let i = 0; i < thumbsUp && i < resultIds.length; i++) {
      ctx.supabase.getTable('ratings').push({
        id: crypto.randomUUID(),
        review_result_id: resultIds[i],
        rater_github_id: raterIdCounter++,
        emoji: 'thumbs_up',
        created_at: new Date().toISOString(),
      });
    }
    // If more thumbs up than results, add extra to the first result
    for (let i = resultIds.length; i < thumbsUp; i++) {
      ctx.supabase.getTable('ratings').push({
        id: crypto.randomUUID(),
        review_result_id: resultIds[0],
        rater_github_id: raterIdCounter++,
        emoji: 'thumbs_up',
        created_at: new Date().toISOString(),
      });
    }

    for (let i = 0; i < thumbsDown; i++) {
      const targetResult = resultIds[i % resultIds.length];
      ctx.supabase.getTable('ratings').push({
        id: crypto.randomUUID(),
        review_result_id: targetResult,
        rater_github_id: raterIdCounter++,
        emoji: 'thumbs_down',
        created_at: new Date().toISOString(),
      });
    }

    return { user, apiKey, userId, agent, agentId, resultIds };
  }

  it('GET /api/stats/:agentId returns trust tier and basic stats', async () => {
    const { apiKey, agentId } = await createAgentWithReviews(3, 2, 1);

    const req = ctx.authedRequest(`/api/stats/${agentId}`, apiKey);
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      agent: {
        id: string;
        model: string;
        tool: string;
        status: string;
        trustTier: { tier: string; label: string; reviewCount: number };
      };
      stats: {
        totalReviews: number;
        totalRatings: number;
        thumbsUp: number;
        thumbsDown: number;
      };
    };

    expect(body.agent.id).toBe(agentId);
    expect(body.agent.model).toBe('test-model');
    expect(body.agent.trustTier).toBeDefined();
    expect(body.agent.trustTier.tier).toBeDefined();
    expect(body.stats.totalReviews).toBe(3);
    expect(body.stats.totalRatings).toBe(3);
    expect(body.stats.thumbsUp).toBe(2);
    expect(body.stats.thumbsDown).toBe(1);
  });

  it('newcomer tier for agent with 0 reviews', async () => {
    const { apiKey, agentId } = await createAgentWithReviews(0, 0, 0, {
      name: 'newcomer',
      github_id: 10001,
    });

    const req = ctx.authedRequest(`/api/stats/${agentId}`, apiKey);
    const res = await ctx.workerFetch(req);
    const body = (await res.json()) as {
      agent: { trustTier: { tier: string; label: string } };
    };

    expect(body.agent.trustTier.tier).toBe('newcomer');
    expect(body.agent.trustTier.label).toBe('Newcomer');
  });

  it('trusted tier for agent with 5+ reviews and >=60% positive', async () => {
    // 6 reviews, 4 thumbs up, 2 thumbs down = 67% positive
    const { apiKey, agentId } = await createAgentWithReviews(6, 4, 2, {
      name: 'trusted-user',
      github_id: 10002,
    });

    const req = ctx.authedRequest(`/api/stats/${agentId}`, apiKey);
    const res = await ctx.workerFetch(req);
    const body = (await res.json()) as {
      agent: { trustTier: { tier: string; label: string } };
    };

    expect(body.agent.trustTier.tier).toBe('trusted');
    expect(body.agent.trustTier.label).toBe('Trusted');
  });

  it('expert tier for agent with 20+ reviews and >=80% positive', async () => {
    // 22 reviews, 20 thumbs up, 2 thumbs down = ~91% positive
    const { apiKey, agentId } = await createAgentWithReviews(22, 20, 2, {
      name: 'expert-user',
      github_id: 10003,
    });

    const req = ctx.authedRequest(`/api/stats/${agentId}`, apiKey);
    const res = await ctx.workerFetch(req);
    const body = (await res.json()) as {
      agent: { trustTier: { tier: string; label: string } };
    };

    expect(body.agent.trustTier.tier).toBe('expert');
    expect(body.agent.trustTier.label).toBe('Expert');
  });

  it('GET /api/projects/stats returns aggregate statistics (public, no auth)', async () => {
    // Seed some data: agents, completed review results with proper join chain
    const { user } = await ctx.createUser({ name: 'contributor1', github_id: 20001 });
    const agent = await ctx.createAgent(user.id as string);
    const statsProject = await ctx.createProject({ owner: 'stat-owner', repo: 'stat-repo', repo_full_name: 'stat-owner/stat-repo' });
    const taskId = crypto.randomUUID();

    ctx.supabase.getTable('review_tasks').push({
      id: taskId,
      project_id: statsProject.id,
      pr_number: 10,
      pr_url: 'https://github.com/stat-owner/stat-repo/pull/10',
      status: 'completed',
      created_at: new Date().toISOString(),
    });

    ctx.supabase.getTable('review_results').push({
      id: crypto.randomUUID(),
      review_task_id: taskId,
      agent_id: agent.id,
      status: 'completed',
      completed_at: new Date().toISOString(),
      created_at: new Date().toISOString(),
    });

    // No auth header — this is a public endpoint
    const req = new Request('https://api.opencara.dev/api/projects/stats');
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      totalReviews: number;
      totalContributors: number;
      averagePositiveRate: number;
      recentActivity: unknown[];
    };

    expect(body.totalReviews).toBeGreaterThanOrEqual(1);
    expect(body.totalContributors).toBeGreaterThanOrEqual(1);
    expect(typeof body.averagePositiveRate).toBe('number');
    expect(Array.isArray(body.recentActivity)).toBe(true);
  });

  it('stats include token consumption totals', async () => {
    const { apiKey, agentId } = await createAgentWithReviews(2, 1, 0, {
      name: 'consumption-test',
      github_id: 30001,
    });

    // Add consumption logs
    ctx.supabase.getTable('consumption_logs').push(
      {
        id: crypto.randomUUID(),
        agent_id: agentId,
        review_task_id: crypto.randomUUID(),
        tokens_used: 1500,
        created_at: new Date().toISOString(),
      },
      {
        id: crypto.randomUUID(),
        agent_id: agentId,
        review_task_id: crypto.randomUUID(),
        tokens_used: 2500,
        created_at: new Date().toISOString(),
      },
    );

    const req = ctx.authedRequest(`/api/stats/${agentId}`, apiKey);
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      stats: { tokensUsed: number };
    };

    expect(body.stats.tokensUsed).toBe(4000);
  });

  it('agent not found returns 404', async () => {
    const { apiKey } = await ctx.createUser({ name: 'no-agent', github_id: 40001 });

    const req = ctx.authedRequest(`/api/stats/${crypto.randomUUID()}`, apiKey);
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(404);
  });

  it("different user's agent returns 404", async () => {
    // Create agent owned by user A
    const { user: ownerUser } = await ctx.createUser({
      name: 'owner-a',
      github_id: 50001,
    });
    const agent = await ctx.createAgent(ownerUser.id as string);
    const agentId = agent.id as string;

    // Create user B who tries to view agent A's stats
    const { apiKey: otherApiKey } = await ctx.createUser({
      name: 'user-b',
      github_id: 50002,
    });

    const req = ctx.authedRequest(`/api/stats/${agentId}`, otherApiKey);
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(404);
  });
});
