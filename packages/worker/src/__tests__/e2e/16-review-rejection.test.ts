import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';
import { buildPullRequestPayload } from './helpers/webhook-builder.js';
import type { MockWebSocketPair } from './helpers/mock-websocket.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Review Rejection & Redistribution', () => {
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

  /** Send a PR webhook. */
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

  interface ConnectedAgent {
    user: Record<string, unknown>;
    apiKey: string;
    agent: Record<string, unknown>;
    agentId: string;
    pair: MockWebSocketPair;
  }

  /** Create and WS-connect multiple agents. */
  async function setupMultipleAgents(count: number): Promise<ConnectedAgent[]> {
    const agents: ConnectedAgent[] = [];
    for (let i = 0; i < count; i++) {
      const { user, apiKey } = await ctx.createUser({ name: `user${i}` });
      const agent = await ctx.createAgent(user.id as string, { status: 'online' });
      const agentId = agent.id as string;

      const wsReq = new Request(`https://api.opencara.dev/ws/agent/${agentId}?token=${apiKey}`, {
        headers: { Upgrade: 'websocket' },
      });
      await ctx.workerFetch(wsReq);

      const pair = ctx.getLastWSPair()!;
      agents.push({ user, apiKey, agent, agentId, pair });
    }
    return agents;
  }

  /** Find the review_request taskId from a WS pair. */
  function findReviewRequest(pair: MockWebSocketPair) {
    return pair.client
      .getReceivedParsed<{ type: string; taskId: string }>()
      .find((m) => m.type === 'review_request');
  }

  /** Find which agent received the review_request (weighted random makes order non-deterministic). */
  function findAgentWithReviewRequest(agents: ConnectedAgent[]) {
    for (const agent of agents) {
      const req = findReviewRequest(agent.pair);
      if (req) return { agent, req };
    }
    return undefined;
  }

  /** Find the other agent that did NOT receive the initial review. */
  function findOtherAgent(agents: ConnectedAgent[], excludeId: string) {
    return agents.find((a) => a.agentId !== excludeId)!;
  }

  it('review_rejected → redistributed to next agent', async () => {
    const agents = await setupMultipleAgents(2);

    await sendPRWebhook();

    // Find which agent received the task (non-deterministic with weighted random)
    const firstResult = findAgentWithReviewRequest(agents);
    expect(firstResult).toBeDefined();
    const { agent: firstAgent, req: reviewReq } = firstResult!;

    // First agent rejects
    await ctx.simulateAgentMessage(firstAgent.agentId, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_rejected',
      taskId: reviewReq.taskId,
      reason: 'Not my area of expertise',
    });

    // Other agent should receive the redistributed task
    const otherAgent = findOtherAgent(agents, firstAgent.agentId);
    const redistributedReq = findReviewRequest(otherAgent.pair);
    expect(redistributedReq).toBeDefined();
    expect(redistributedReq!.taskId).toBe(reviewReq.taskId);
  });

  it('review_error → redistributed to next agent', async () => {
    const agents = await setupMultipleAgents(2);

    await sendPRWebhook();

    const firstResult = findAgentWithReviewRequest(agents);
    expect(firstResult).toBeDefined();
    const { agent: firstAgent, req: reviewReq } = firstResult!;

    // First agent errors
    await ctx.simulateAgentMessage(firstAgent.agentId, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_error',
      taskId: reviewReq.taskId,
      error: 'API rate limited',
    });

    // Other agent should receive the redistributed task
    const otherAgent = findOtherAgent(agents, firstAgent.agentId);
    const redistributedReq = findReviewRequest(otherAgent.pair);
    expect(redistributedReq).toBeDefined();
    expect(redistributedReq!.taskId).toBe(reviewReq.taskId);
  });

  it('3 failures → task status=failed', async () => {
    const agents = await setupMultipleAgents(3);

    await sendPRWebhook();

    // Find the agent that received the first review request
    const first = findAgentWithReviewRequest(agents);
    expect(first).toBeDefined();
    const taskId = first!.req.taskId;

    // Agent 1 rejects
    await ctx.simulateAgentMessage(first!.agent.agentId, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_rejected',
      taskId,
      reason: 'Rejected',
    });

    // Find the agent that received the redistributed task
    const remainingAfterFirst = agents.filter((a) => a.agentId !== first!.agent.agentId);
    const second = findAgentWithReviewRequest(remainingAfterFirst);
    expect(second).toBeDefined();

    // Agent 2 rejects
    await ctx.simulateAgentMessage(second!.agent.agentId, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_rejected',
      taskId,
      reason: 'Rejected',
    });

    // Find the last remaining agent
    const remainingAfterSecond = remainingAfterFirst.filter(
      (a) => a.agentId !== second!.agent.agentId,
    );
    const third = findAgentWithReviewRequest(remainingAfterSecond);
    expect(third).toBeDefined();

    // Agent 3 rejects
    await ctx.simulateAgentMessage(third!.agent.agentId, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_rejected',
      taskId,
      reason: 'Rejected',
    });

    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.id === taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('failed');
  });

  it('previously-attempted agents excluded from redistribution', async () => {
    const agents = await setupMultipleAgents(2);

    await sendPRWebhook();

    // Find which agent received the task
    const firstResult = findAgentWithReviewRequest(agents);
    expect(firstResult).toBeDefined();
    const { agent: firstAgent, req: req1 } = firstResult!;

    // First agent rejects
    await ctx.simulateAgentMessage(firstAgent.agentId, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_rejected',
      taskId: req1.taskId,
      reason: 'Rejected',
    });

    // Other agent gets the redistribution (not the first agent again)
    const otherAgent = findOtherAgent(agents, firstAgent.agentId);
    const req2 = findReviewRequest(otherAgent.pair);
    expect(req2).toBeDefined();
    expect(req2!.taskId).toBe(req1.taskId);

    // First agent should NOT have received a second review_request
    const firstAgentRequests = firstAgent.pair.client
      .getReceivedParsed<{ type: string }>()
      .filter((m) => m.type === 'review_request');
    expect(firstAgentRequests.length).toBe(1);
  });

  it('no remaining agents → task fails', async () => {
    // Only 1 agent available
    const agents = await setupMultipleAgents(1);

    await sendPRWebhook();

    const firstResult = findAgentWithReviewRequest(agents);
    expect(firstResult).toBeDefined();

    await ctx.simulateAgentMessage(firstResult!.agent.agentId, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_rejected',
      taskId: firstResult!.req.taskId,
      reason: 'Rejected',
    });

    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.id === firstResult!.req.taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('failed');
  });

  it('review_results has rows per attempt', async () => {
    const agents = await setupMultipleAgents(2);

    await sendPRWebhook();

    // Find which agent got the task first
    const firstResult = findAgentWithReviewRequest(agents);
    expect(firstResult).toBeDefined();
    const { agent: firstAgent, req: req1 } = firstResult!;

    // First agent rejects
    await ctx.simulateAgentMessage(firstAgent.agentId, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_rejected',
      taskId: req1.taskId,
      reason: 'Rejected',
    });

    // Other agent completes
    const otherAgent = findOtherAgent(agents, firstAgent.agentId);
    const req2 = findReviewRequest(otherAgent.pair);
    expect(req2).toBeDefined();
    await ctx.simulateAgentMessage(otherAgent.agentId, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_complete',
      taskId: req2!.taskId,
      review: '## Summary\nLGTM\n\n## Verdict\nAPPROVE',
      verdict: 'approve',
      tokensUsed: 1000,
    });

    const results = ctx.supabase.getTable('review_results');
    const taskResults = results.filter((r) => r.review_task_id === req1.taskId);
    // 1 rejected + 1 completed = 2 rows
    expect(taskResults.length).toBe(2);
    expect(taskResults.some((r) => r.status === 'rejected')).toBe(true);
    expect(taskResults.some((r) => r.status === 'completed')).toBe(true);
  });

  it('mixed rejection/error: agent1 rejects, agent2 errors, agent3 errors → task failed', async () => {
    const agents = await setupMultipleAgents(3);

    await sendPRWebhook();

    // Find the agent that received the first review request
    const first = findAgentWithReviewRequest(agents);
    expect(first).toBeDefined();
    const taskId = first!.req.taskId;

    // Agent 1 rejects
    await ctx.simulateAgentMessage(first!.agent.agentId, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_rejected',
      taskId,
      reason: 'Not my area',
    });

    // Find the agent that received the redistributed task
    const remainingAfterFirst = agents.filter((a) => a.agentId !== first!.agent.agentId);
    const second = findAgentWithReviewRequest(remainingAfterFirst);
    expect(second).toBeDefined();

    // Agent 2 errors
    await ctx.simulateAgentMessage(second!.agent.agentId, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_error',
      taskId,
      error: 'API rate limited',
    });

    // Find the last remaining agent
    const remainingAfterSecond = remainingAfterFirst.filter(
      (a) => a.agentId !== second!.agent.agentId,
    );
    const third = findAgentWithReviewRequest(remainingAfterSecond);
    expect(third).toBeDefined();

    // Agent 3 errors
    await ctx.simulateAgentMessage(third!.agent.agentId, {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_error',
      taskId,
      error: 'Timeout',
    });

    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.id === taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('failed');
  });
});
