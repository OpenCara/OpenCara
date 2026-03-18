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

  /** Set up project, 4 users+agents (3 reviewers + 1 summary), all WS-connected. */
  async function setupMultiAgentEnv() {
    // Create project with matching installation id
    const project = await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
    });

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
        reputation_score: 0.5 + i * 0.1, // 0.5, 0.6, 0.7, 0.8
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

    return { project, agents };
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

  it('highest-rep agent is pre-selected as synthesizer and receives summary_request', async () => {
    const { agents } = await setupMultiAgentEnv();
    const taskId = await sendWebhook();

    // Agents have reputation: 0.5, 0.6, 0.7, 0.8
    // Highest-rep agent (agents[3], rep=0.8) should be reserved as synthesizer
    // The other 3 should be reviewers
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

    // The highest-rep agent should be the synthesizer
    const synthesizerAgent = agents[3]; // rep=0.8 (highest)
    expect(reviewerAgentIds).not.toContain(synthesizerAgent.agentId);

    // Check review_summaries table
    const summaries = ctx.supabase.getTable('review_summaries');
    expect(summaries.length).toBe(1);
    expect(summaries[0].agent_id).toBe(synthesizerAgent.agentId);

    // Synthesizer's DO should have a summary_request in-flight
    const summaryState = ctx.agentConnectionNS.getState(synthesizerAgent.agentId);
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

    // Identify summary agent
    const summaries = ctx.supabase.getTable('review_summaries');
    const summaryAgentId = summaries[0].agent_id as string;

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

    const summaries = ctx.supabase.getTable('review_summaries');
    const summaryAgentId = summaries[0].agent_id as string;

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
    // Only create 1 agent — can't do multi-agent review
    await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
    });

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
      reputation_score: 0.5,
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

  it('consumption logs created for all reviewing agents', async () => {
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

    // Check consumption_logs for each reviewer
    const logs = ctx.supabase.getTable('consumption_logs');
    for (const agentId of reviewerAgentIds) {
      const agentLogs = logs.filter((l) => l.agent_id === agentId && l.review_task_id === taskId);
      expect(agentLogs.length).toBe(1);
      expect(agentLogs[0].tokens_used).toBe(250);
    }
  });
});
