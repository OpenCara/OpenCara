import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';
import { buildPullRequestPayload } from './helpers/webhook-builder.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Single-Agent Review Loop', () => {
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

  /** Send a PR webhook and return the response. */
  async function sendPRWebhook() {
    const payload = buildPullRequestPayload({ action: 'opened' });
    const body = JSON.stringify(payload);
    const sig = await ctx.signWebhook(body);
    const req = new Request('https://api.opencara.dev/webhook/github', {
      method: 'POST',
      headers: {
        'X-Hub-Signature-256': sig,
        'X-GitHub-Event': 'pull_request',
        'Content-Type': 'application/json',
      },
      body,
    });
    return ctx.workerFetch(req);
  }

  /** Create user, agent, project, connect agent, and return everything. */
  async function setupConnectedAgent() {
    const { user, apiKey } = await ctx.createUser();
    const agent = await ctx.createAgent(user.id as string, { status: 'online' });
    const agentId = agent.id as string;
    const wsReq = new Request(`https://api.opencara.dev/ws/agent/${agentId}?token=${apiKey}`, {
      headers: { Upgrade: 'websocket' },
    });
    await ctx.workerFetch(wsReq);

    const pair = ctx.getLastWSPair()!;
    return { user, apiKey, agent, agentId, pair };
  }

  /** Send webhook then simulate review_complete. Returns the taskId. */
  async function fullReviewFlow(
    agentId: string,
    pair: NonNullable<ReturnType<typeof ctx.getLastWSPair>>,
    verdict: string = 'approve',
  ) {
    await sendPRWebhook();

    const reviewReq = pair.client
      .getReceivedParsed<{ type: string; taskId: string }>()
      .find((m) => m.type === 'review_request');
    expect(reviewReq).toBeDefined();

    const taskId = reviewReq!.taskId;

    await ctx.simulateAgentMessage(agentId, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_complete',
      taskId,
      review: '## Summary\nLooks good\n\n## Verdict\nAPPROVE',
      verdict,
      tokensUsed: 1500,
    });

    return taskId;
  }

  it('full flow: webhook → agent receives review_request with diffContent', async () => {
    const { pair } = await setupConnectedAgent();

    await sendPRWebhook();

    const messages = pair.client.getReceivedParsed<{
      type: string;
      diffContent?: string;
    }>();
    const reviewReq = messages.find((m) => m.type === 'review_request');
    expect(reviewReq).toBeDefined();
    expect(reviewReq!.diffContent).toBeDefined();
    expect(reviewReq!.diffContent!.length).toBeGreaterThan(0);
  });

  it('review_complete → review posted to GitHub', async () => {
    const { agentId, pair } = await setupConnectedAgent();

    await fullReviewFlow(agentId, pair);

    expect(ctx.github.postedReviews.length).toBeGreaterThanOrEqual(1);
    expect(ctx.github.postedReviews[0].owner).toBe('test-owner');
    expect(ctx.github.postedReviews[0].repo).toBe('test-repo');
    expect(ctx.github.postedReviews[0].prNumber).toBe(1);
  });

  it('review has OpenCara formatting (verdict, model, tool)', async () => {
    const { agentId, pair } = await setupConnectedAgent();

    await fullReviewFlow(agentId, pair);

    const review = ctx.github.postedReviews[0];
    expect(review.body).toContain('OpenCara Review');
    expect(review.body).toContain('Verdict');
    expect(review.body).toContain('Agent');
  });

  it('review_results has type=review after posting', async () => {
    const { agentId, pair } = await setupConnectedAgent();

    const taskId = await fullReviewFlow(agentId, pair);

    const results = ctx.supabase.getTable('review_results');
    const result = results.find((r) => r.review_task_id === taskId && r.status === 'completed');
    expect(result).toBeDefined();
    expect(result!.type).toBe('review');
  });

  it('status transitions: pending → reviewing → completed', async () => {
    const { agentId, pair } = await setupConnectedAgent();

    const taskId = await fullReviewFlow(agentId, pair);

    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.id === taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('completed');
  });

  it('APPROVE verdict → APPROVE GitHub event', async () => {
    const { agentId, pair } = await setupConnectedAgent();

    await fullReviewFlow(agentId, pair, 'approve');

    expect(ctx.github.postedReviews[0].event).toBe('APPROVE');
  });

  it('REQUEST_CHANGES verdict → REQUEST_CHANGES event', async () => {
    const { agentId, pair } = await setupConnectedAgent();

    await sendPRWebhook();

    const reviewReq = pair.client
      .getReceivedParsed<{ type: string; taskId: string }>()
      .find((m) => m.type === 'review_request');

    await ctx.simulateAgentMessage(agentId, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_complete',
      taskId: reviewReq!.taskId,
      review: '## Summary\nNeeds changes\n\n## Verdict\nREQUEST_CHANGES',
      verdict: 'request_changes',
      tokensUsed: 1200,
    });

    expect(ctx.github.postedReviews[0].event).toBe('REQUEST_CHANGES');
  });

  it('COMMENT verdict → COMMENT event', async () => {
    const { agentId, pair } = await setupConnectedAgent();

    await sendPRWebhook();

    const reviewReq = pair.client
      .getReceivedParsed<{ type: string; taskId: string }>()
      .find((m) => m.type === 'review_request');

    await ctx.simulateAgentMessage(agentId, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_complete',
      taskId: reviewReq!.taskId,
      review: '## Summary\nSome comments\n\n## Verdict\nCOMMENT',
      verdict: 'comment',
      tokensUsed: 1000,
    });

    expect(ctx.github.postedReviews[0].event).toBe('COMMENT');
  });

  it('contributor name appears in review comment', async () => {
    const { agentId, pair } = await setupConnectedAgent();

    await fullReviewFlow(agentId, pair);

    const review = ctx.github.postedReviews[0];
    expect(review.body).toContain('@testuser');
  });
});
