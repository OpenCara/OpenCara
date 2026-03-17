import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Reputation System & Rating Collection', () => {
  let ctx: E2EContext;

  beforeEach(() => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(ctx.supabase.client as ReturnType<typeof createSupabaseClient>);
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  /**
   * Set up a completed review scenario with a review_result that has a comment_url.
   * The collect-ratings handler joins review_tasks -> projects!inner(user_id),
   * so projects must have user_id to satisfy the ownership check.
   */
  async function setupCompletedReview() {
    const { user, apiKey } = await ctx.createUser({ name: 'owner-user' });
    const userId = user.id as string;

    const agent = await ctx.createAgent(userId, {
      reputation_score: 0.5,
      model: 'test-model',
      tool: 'test-tool',
    });
    const agentId = agent.id as string;

    // Project needs user_id for the ownership check in collect-ratings handler
    const project = await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
      user_id: userId,
    });
    const projectId = project.id as string;

    // Create a completed review task
    const taskId = crypto.randomUUID();
    ctx.supabase.getTable('review_tasks').push({
      id: taskId,
      project_id: projectId,
      pr_number: 1,
      pr_url: 'https://github.com/test-owner/test-repo/pull/1',
      status: 'completed',
      timeout_at: new Date(Date.now() + 600_000).toISOString(),
      created_at: new Date().toISOString(),
    });

    // Create a review result with comment_url containing a parseable comment ID
    const resultId = crypto.randomUUID();
    ctx.supabase.getTable('review_results').push({
      id: resultId,
      review_task_id: taskId,
      agent_id: agentId,
      status: 'completed',
      review_text: 'Test review',
      verdict: 'approve',
      comment_url:
        'https://github.com/test-owner/test-repo/pull/1#issuecomment-12345',
      created_at: new Date().toISOString(),
    });

    return { user, apiKey, userId, agent, agentId, project, projectId, taskId, resultId };
  }

  it('collect-ratings fetches GitHub reactions and returns collected count', async () => {
    const { apiKey, taskId } = await setupCompletedReview();

    // Set up GitHub reactions mock
    ctx.github.options.reactions = {
      'test-owner/test-repo/12345': [
        { content: '+1', user: { id: 100, login: 'rater1' } },
      ],
    };

    const req = ctx.authedRequest(`/api/tasks/${taskId}/collect-ratings`, apiKey, {
      method: 'POST',
    });
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { collected: number };
    expect(body.collected).toBeGreaterThanOrEqual(1);
  });

  it('+1 reaction creates rating with emoji=thumbs_up', async () => {
    const { apiKey, taskId, resultId } = await setupCompletedReview();

    ctx.github.options.reactions = {
      'test-owner/test-repo/12345': [
        { content: '+1', user: { id: 200, login: 'positive-rater' } },
      ],
    };

    const req = ctx.authedRequest(`/api/tasks/${taskId}/collect-ratings`, apiKey, {
      method: 'POST',
    });
    await ctx.workerFetch(req);

    const ratings = ctx.supabase.getTable('ratings');
    const rating = ratings.find(
      (r) => r.review_result_id === resultId && r.rater_github_id === 200,
    );
    expect(rating).toBeDefined();
    expect(rating!.emoji).toBe('thumbs_up');
  });

  it('-1 reaction creates rating with emoji=thumbs_down', async () => {
    const { apiKey, taskId, resultId } = await setupCompletedReview();

    ctx.github.options.reactions = {
      'test-owner/test-repo/12345': [
        { content: '-1', user: { id: 300, login: 'negative-rater' } },
      ],
    };

    const req = ctx.authedRequest(`/api/tasks/${taskId}/collect-ratings`, apiKey, {
      method: 'POST',
    });
    await ctx.workerFetch(req);

    const ratings = ctx.supabase.getTable('ratings');
    const rating = ratings.find(
      (r) => r.review_result_id === resultId && r.rater_github_id === 300,
    );
    expect(rating).toBeDefined();
    expect(rating!.emoji).toBe('thumbs_down');
  });

  it('agent reputation recalculated with Wilson score > 0 after positive rating', async () => {
    const { apiKey, taskId, agentId } = await setupCompletedReview();

    ctx.github.options.reactions = {
      'test-owner/test-repo/12345': [
        { content: '+1', user: { id: 400, login: 'rater-a' } },
        { content: '+1', user: { id: 401, login: 'rater-b' } },
      ],
    };

    const req = ctx.authedRequest(`/api/tasks/${taskId}/collect-ratings`, apiKey, {
      method: 'POST',
    });
    const res = await ctx.workerFetch(req);
    const body = (await res.json()) as {
      ratings: Array<{ agentId: string; newScore: number; thumbsUp: number }>;
    };

    // The agent's reputation should have been recalculated
    const agentRating = body.ratings.find((r) => r.agentId === agentId);
    expect(agentRating).toBeDefined();
    expect(agentRating!.newScore).toBeGreaterThan(0);
    expect(agentRating!.thumbsUp).toBe(2);

    // Verify agent's reputation_score was updated in DB
    const agents = ctx.supabase.getTable('agents');
    const dbAgent = agents.find((a) => a.id === agentId);
    expect(dbAgent).toBeDefined();
    expect(dbAgent!.reputation_score).toBeGreaterThan(0);
  });

  it('reputation_history entry created on score change', async () => {
    const { apiKey, taskId, agentId } = await setupCompletedReview();

    // Use initial score of 0.5, positive ratings will change it
    ctx.github.options.reactions = {
      'test-owner/test-repo/12345': [
        { content: '+1', user: { id: 500, login: 'rater-x' } },
      ],
    };

    const req = ctx.authedRequest(`/api/tasks/${taskId}/collect-ratings`, apiKey, {
      method: 'POST',
    });
    await ctx.workerFetch(req);

    const history = ctx.supabase.getTable('reputation_history');
    const entry = history.find((h) => h.agent_id === agentId);
    expect(entry).toBeDefined();
    expect(entry!.score_change).toBeDefined();
    expect(typeof entry!.score_change).toBe('number');
    expect(entry!.reason).toBeDefined();
  });

  it('duplicate reactions upserted without creating duplicate rows', async () => {
    const { apiKey, taskId, resultId } = await setupCompletedReview();

    ctx.github.options.reactions = {
      'test-owner/test-repo/12345': [
        { content: '+1', user: { id: 600, login: 'repeat-rater' } },
      ],
    };

    // Collect ratings twice
    const req1 = ctx.authedRequest(`/api/tasks/${taskId}/collect-ratings`, apiKey, {
      method: 'POST',
    });
    await ctx.workerFetch(req1);

    const req2 = ctx.authedRequest(`/api/tasks/${taskId}/collect-ratings`, apiKey, {
      method: 'POST',
    });
    await ctx.workerFetch(req2);

    // Should have exactly 1 rating row for this rater, not 2
    const ratings = ctx.supabase.getTable('ratings');
    const matchingRatings = ratings.filter(
      (r) => r.review_result_id === resultId && r.rater_github_id === 600,
    );
    expect(matchingRatings.length).toBe(1);
  });

  it('task not found returns 404', async () => {
    const { apiKey } = await setupCompletedReview();

    const req = ctx.authedRequest(
      '/api/tasks/non-existent-task-id/collect-ratings',
      apiKey,
      { method: 'POST' },
    );
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(404);
  });

  it("different user's task returns 404", async () => {
    const { taskId } = await setupCompletedReview();

    // Create a different user
    const { apiKey: otherApiKey } = await ctx.createUser({
      name: 'other-user',
      github_id: 999999,
    });

    const req = ctx.authedRequest(
      `/api/tasks/${taskId}/collect-ratings`,
      otherApiKey,
      { method: 'POST' },
    );
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(404);
  });
});
