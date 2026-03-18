import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';
import { buildPullRequestPayload } from './helpers/webhook-builder.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Multi-Agent Review with Summarization', () => {
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

  /** Set up 4 users+agents (3 reviewers + 1 summary), all WS-connected. */
  async function setupMultiAgentEnv() {
    // Set review config with reviewCount: 3
    ctx.github.options.reviewConfigs = {
      'test-owner/test-repo': [
        'version: 1',
        'agents:',
        '  review_count: 3',
        '  min_reputation: 0',
        'trigger:',
        '  on: [opened]',
        '  comment: /opencara review',
        '  skip: []',
        'timeout: "10m"',
        'prompt: "Review this PR"',
        'reviewer:',
        '  whitelist: []',
        '  blacklist: []',
      ].join('\n'),
    };

    // Create 4 users + agents (3 reviewers + 1 summary agent)
    const agents: Array<{
      user: Record<string, unknown>;
      apiKey: string;
      agent: Record<string, unknown>;
      agentId: string;
    }> = [];

    for (let i = 0; i < 4; i++) {
      const { user, apiKey } = await ctx.createUser({
        name: `user${i}`,
        github_id: 1000 + i,
      });
      const agent = await ctx.createAgent(user.id as string, {
        status: 'online',
        model: `model-${i}`,
        tool: `tool-${i}`,
      });
      agents.push({
        user,
        apiKey,
        agent,
        agentId: agent.id as string,
      });
    }

    // Connect all 4 agents via WebSocket
    for (const a of agents) {
      const wsReq = new Request(
        `https://api.opencara.dev/ws/agent/${a.agentId}?token=${a.apiKey}`,
        { headers: { Upgrade: 'websocket' } },
      );
      const res = await ctx.workerFetch(wsReq);
      expect(res.status).toBe(101);
    }

    return { agents };
  }

  /** Send a PR webhook and return the created task ID. */
  async function sendWebhook(): Promise<string> {
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
    await ctx.workerFetch(req);

    // Find the created task
    const tasks = ctx.supabase.getTable('review_tasks');
    expect(tasks.length).toBeGreaterThan(0);
    return tasks[tasks.length - 1].id as string;
  }

  /** Find which WS pairs received a review_request message. */
  function findReviewRequestPairs() {
    const allPairs = ctx.wsPairs.getAllPairs();
    return allPairs.filter((pair) => {
      const messages = pair.client.getReceivedParsed<{ type: string }>();
      return messages.some((m) => m.type === 'review_request');
    });
  }

  it('reviewCount=3 distributes review_request to 3 reviewers (synthesizer reserved)', async () => {
    await setupMultiAgentEnv();
    await sendWebhook();

    // With 4 agents and review_count=3: 3 reviewers + 1 synthesizer
    const pairsWithRequest = findReviewRequestPairs();
    expect(pairsWithRequest.length).toBe(3);
  });

  it('reviewMode=compact for multi-agent reviews', async () => {
    await setupMultiAgentEnv();
    await sendWebhook();

    const pairsWithRequest = findReviewRequestPairs();
    for (const pair of pairsWithRequest) {
      const reviewReq = pair.client
        .getReceivedParsed<{ type: string; reviewMode: string }>()
        .find((m) => m.type === 'review_request');
      expect(reviewReq).toBeDefined();
      expect(reviewReq!.reviewMode).toBe('compact');
    }
  });

  it('after all 3 reviews complete, task status transitions to summarizing', async () => {
    const { agents } = await setupMultiAgentEnv();
    const taskId = await sendWebhook();

    // Find the agents that received review_requests (reviewers, not synthesizer)
    const reviewerAgentIds: string[] = [];
    for (const a of agents) {
      const state = ctx.agentConnectionNS.getState(a.agentId);
      if (state) {
        const inFlight = await state.storage.get<string[]>('inFlightTaskIds');
        if (inFlight && inFlight.includes(taskId)) {
          reviewerAgentIds.push(a.agentId);
        }
      }
    }
    // 3 reviewers (synthesizer is reserved, not assigned review tasks yet)
    expect(reviewerAgentIds.length).toBe(3);

    // Simulate review_complete from all 3 agents
    for (const agentId of reviewerAgentIds) {
      await ctx.simulateAgentMessage(agentId, {
        type: 'review_complete',
        taskId,
        review: 'LGTM from agent',
        verdict: 'approve',
        tokensUsed: 100,
      });
    }

    // Task should transition to 'summarizing'
    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.id === taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('summarizing');
  });

  it('synthesizer is pre-selected and receives summary_request after all reviews complete', async () => {
    const { agents } = await setupMultiAgentEnv();
    const taskId = await sendWebhook();

    // All agents have equal weight now (reputation_score removed)
    // The first selected agent is the synthesizer
    const reviewerAgentIds: string[] = [];
    for (const a of agents) {
      const state = ctx.agentConnectionNS.getState(a.agentId);
      if (state) {
        const inFlight = await state.storage.get<string[]>('inFlightTaskIds');
        if (inFlight && inFlight.includes(taskId)) {
          reviewerAgentIds.push(a.agentId);
        }
      }
    }

    // Simulate review_complete from all reviewers
    for (const agentId of reviewerAgentIds) {
      await ctx.simulateAgentMessage(agentId, {
        type: 'review_complete',
        taskId,
        review: 'LGTM from agent',
        verdict: 'approve',
        tokensUsed: 100,
      });
    }

    // The synthesizer should NOT be one of the reviewers
    const synthesizerAgentId = agents.find((a) => !reviewerAgentIds.includes(a.agentId))?.agentId;
    expect(synthesizerAgentId).toBeDefined();

    // Check review_results table for type='summary' entry
    const results = ctx.supabase.getTable('review_results');
    const summaryResult = results.find(
      (r) => r.type === 'summary' && r.agent_id === synthesizerAgentId,
    );
    expect(summaryResult).toBeDefined();

    // Synthesizer's DO should have a summary_request in-flight
    const summaryState = ctx.agentConnectionNS.getState(synthesizerAgentId!);
    const summaryInFlight = await summaryState!.storage.get<string[]>('inFlightTaskIds');
    expect(summaryInFlight).toContain(taskId);
  });

  it('summary_complete posts formatted summary to GitHub', async () => {
    const { agents } = await setupMultiAgentEnv();
    const taskId = await sendWebhook();

    // Find reviewers and complete their reviews
    const reviewerAgentIds: string[] = [];
    for (const a of agents) {
      const state = ctx.agentConnectionNS.getState(a.agentId);
      if (state) {
        const inFlight = await state.storage.get<string[]>('inFlightTaskIds');
        if (inFlight && inFlight.includes(taskId)) {
          reviewerAgentIds.push(a.agentId);
        }
      }
    }

    for (const agentId of reviewerAgentIds) {
      await ctx.simulateAgentMessage(agentId, {
        type: 'review_complete',
        taskId,
        review: 'Looks good overall',
        verdict: 'approve',
        tokensUsed: 150,
      });
    }

    // Identify summary agent from review_results (type='summary')
    const results = ctx.supabase.getTable('review_results');
    const summaryResult = results.find((r) => r.type === 'summary');
    expect(summaryResult).toBeDefined();
    const summaryAgentId = summaryResult!.agent_id as string;

    // Simulate summary_complete
    await ctx.simulateAgentMessage(summaryAgentId, {
      type: 'summary_complete',
      taskId,
      summary: 'All agents approved this PR. The changes look clean.',
      tokensUsed: 200,
    });

    // Check that a review was posted to GitHub
    expect(ctx.github.postedReviews.length).toBeGreaterThan(0);
    const review = ctx.github.postedReviews.find((r) => r.body.includes('OpenCara Review'));
    expect(review).toBeDefined();
    expect(review!.owner).toBe('test-owner');
    expect(review!.repo).toBe('test-repo');
    expect(review!.prNumber).toBe(1);
  });

  it('task transitions to completed after summary', async () => {
    const { agents } = await setupMultiAgentEnv();
    const taskId = await sendWebhook();

    // Complete all reviews
    const reviewerAgentIds: string[] = [];
    for (const a of agents) {
      const state = ctx.agentConnectionNS.getState(a.agentId);
      if (state) {
        const inFlight = await state.storage.get<string[]>('inFlightTaskIds');
        if (inFlight && inFlight.includes(taskId)) {
          reviewerAgentIds.push(a.agentId);
        }
      }
    }

    for (const agentId of reviewerAgentIds) {
      await ctx.simulateAgentMessage(agentId, {
        type: 'review_complete',
        taskId,
        review: 'LGTM',
        verdict: 'approve',
        tokensUsed: 100,
      });
    }

    const results = ctx.supabase.getTable('review_results');
    const summaryResult = results.find((r) => r.type === 'summary');
    expect(summaryResult).toBeDefined();
    const summaryAgentId = summaryResult!.agent_id as string;

    await ctx.simulateAgentMessage(summaryAgentId, {
      type: 'summary_complete',
      taskId,
      summary: 'Summary: all good.',
      tokensUsed: 200,
    });

    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.id === taskId);
    expect(task!.status).toBe('completed');
  });

  it('with only 1 agent available, falls back to single-agent mode (no multi-agent)', async () => {
    ctx.github.options.reviewConfigs = {
      'test-owner/test-repo': [
        'version: 1',
        'agents:',
        '  review_count: 3',
        '  min_reputation: 0',
        'trigger:',
        '  on: [opened]',
        '  comment: /opencara review',
        '  skip: []',
        'timeout: "10m"',
        'prompt: "Review this PR"',
        'reviewer:',
        '  whitelist: []',
        '  blacklist: []',
      ].join('\n'),
    };

    const { user, apiKey } = await ctx.createUser({ name: 'solo', github_id: 2000 });
    const agent = await ctx.createAgent(user.id as string, {
      status: 'online',
    });
    const agentId = agent.id as string;

    const wsReq = new Request(`https://api.opencara.dev/ws/agent/${agentId}?token=${apiKey}`, {
      headers: { Upgrade: 'websocket' },
    });
    await ctx.workerFetch(wsReq);

    const taskId = await sendWebhook();

    // Single agent should receive review_request (no multi-agent possible with 1 agent)
    const state = ctx.agentConnectionNS.getState(agentId);
    const inFlight = await state!.storage.get<string[]>('inFlightTaskIds');
    expect(inFlight).toContain(taskId);

    // Complete the review
    await ctx.simulateAgentMessage(agentId, {
      type: 'review_complete',
      taskId,
      review: 'Solo review',
      verdict: 'comment',
      tokensUsed: 80,
    });

    // Review posted directly to GitHub (single-agent mode)
    expect(ctx.github.postedReviews.length).toBeGreaterThanOrEqual(1);

    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.id === taskId);
    expect(task!.status).toBe('completed');
  });

  it('review_results created for all reviewing agents', async () => {
    const { agents } = await setupMultiAgentEnv();
    const taskId = await sendWebhook();

    // Find reviewers
    const reviewerAgentIds: string[] = [];
    for (const a of agents) {
      const state = ctx.agentConnectionNS.getState(a.agentId);
      if (state) {
        const inFlight = await state.storage.get<string[]>('inFlightTaskIds');
        if (inFlight && inFlight.includes(taskId)) {
          reviewerAgentIds.push(a.agentId);
        }
      }
    }

    for (const agentId of reviewerAgentIds) {
      await ctx.simulateAgentMessage(agentId, {
        type: 'review_complete',
        taskId,
        review: 'Review text',
        verdict: 'approve',
        tokensUsed: 250,
      });
    }

    // Check review_results for each reviewer (consumption_logs table was dropped)
    const results = ctx.supabase.getTable('review_results');
    for (const agentId of reviewerAgentIds) {
      const agentResults = results.filter(
        (r) => r.agent_id === agentId && r.review_task_id === taskId && r.type === 'review',
      );
      expect(agentResults.length).toBe(1);
      expect(agentResults[0].status).toBe('completed');
    }
  });
});
