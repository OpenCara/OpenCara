import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';
import { buildPullRequestPayload } from './helpers/webhook-builder.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Task Distribution (PR webhook → task → agent)', () => {
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
  async function sendPRWebhook(overrides?: Parameters<typeof buildPullRequestPayload>[0]) {
    const payload = buildPullRequestPayload(overrides);
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

  /** Create user + agent + project and connect agent via WS. */
  async function setupConnectedAgent(agentOverrides?: Record<string, unknown>) {
    const { user, apiKey } = await ctx.createUser();
    const agent = await ctx.createAgent(user.id as string, {
      status: 'online',
      ...agentOverrides,
    });
    await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
    });

    const agentId = agent.id as string;
    const wsReq = new Request(`https://api.opencara.dev/ws/agent/${agentId}?token=${apiKey}`, {
      headers: { Upgrade: 'websocket' },
    });
    await ctx.workerFetch(wsReq);

    const pair = ctx.getLastWSPair()!;
    return { user, apiKey, agent, agentId, pair };
  }

  it('PR webhook creates a review_tasks row', async () => {
    await setupConnectedAgent();

    const res = await sendPRWebhook({ action: 'opened' });
    expect(res.status).toBe(200);

    const tasks = ctx.supabase.getTable('review_tasks');
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('task status = reviewing after online agent found', async () => {
    await setupConnectedAgent();

    await sendPRWebhook({ action: 'opened' });

    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.pr_number === 1);
    expect(task).toBeDefined();
    expect(task!.status).toBe('reviewing');
  });

  it('project created via findOrCreateProject if not existing', async () => {
    // Do NOT call ctx.createProject() — let the webhook handler create it
    const { user, apiKey } = await ctx.createUser();
    const agent = await ctx.createAgent(user.id as string, { status: 'online' });
    const agentId = agent.id as string;

    const wsReq = new Request(`https://api.opencara.dev/ws/agent/${agentId}?token=${apiKey}`, {
      headers: { Upgrade: 'websocket' },
    });
    await ctx.workerFetch(wsReq);

    await sendPRWebhook({ action: 'opened' });

    const projects = ctx.supabase.getTable('projects');
    const project = projects.find((p) => p.owner === 'test-owner' && p.repo === 'test-repo');
    expect(project).toBeDefined();
    expect(project!.github_installation_id).toBe(12345);
  });

  it('agent DO receives push-task → review_request on WS', async () => {
    const { pair } = await setupConnectedAgent();

    await sendPRWebhook({ action: 'opened' });

    const messages = pair.client.getReceivedParsed<{ type: string }>();
    const reviewReq = messages.find((m) => m.type === 'review_request');
    expect(reviewReq).toBeDefined();
  });

  it('review_request message has correct taskId, pr.number, project.owner fields', async () => {
    const { pair } = await setupConnectedAgent();

    await sendPRWebhook({ action: 'opened' });

    const messages = pair.client.getReceivedParsed<{
      type: string;
      taskId: string;
      pr: { number: number };
      project: { owner: string };
    }>();
    const reviewReq = messages.find((m) => m.type === 'review_request');
    expect(reviewReq).toBeDefined();
    expect(reviewReq!.taskId).toBeTruthy();
    expect(reviewReq!.pr.number).toBe(1);
    expect(reviewReq!.project.owner).toBe('test-owner');
  });

  it('inFlightTaskIds updated in DO after push-task', async () => {
    const { agentId } = await setupConnectedAgent();

    await sendPRWebhook({ action: 'opened' });

    const state = ctx.agentConnectionNS.getState(agentId);
    const inFlight = await state!.storage.get<string[]>('inFlightTaskIds');
    expect(inFlight).toBeDefined();
    expect(inFlight!.length).toBeGreaterThanOrEqual(1);
  });

  it('no eligible agents → task stays pending', async () => {
    // Create project but no online agents
    await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
    });

    await sendPRWebhook({ action: 'opened' });

    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.pr_number === 1);
    expect(task).toBeDefined();
    expect(task!.status).toBe('pending');
  });

  it('minReputation filtering excludes low-reputation agents', async () => {
    // Agent with low reputation
    const { user, apiKey } = await ctx.createUser();
    const agent = await ctx.createAgent(user.id as string, {
      status: 'online',
      reputation_score: 0.1,
    });
    await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
    });

    const agentId = agent.id as string;
    const wsReq = new Request(`https://api.opencara.dev/ws/agent/${agentId}?token=${apiKey}`, {
      headers: { Upgrade: 'websocket' },
    });
    await ctx.workerFetch(wsReq);

    // Set review config with minReputation: 0.5
    ctx.github.options.reviewConfigs = {
      'test-owner/test-repo': [
        'version: 1',
        'prompt: "Review this PR"',
        'agents:',
        '  min_reputation: 0.5',
      ].join('\n'),
    };

    await sendPRWebhook({ action: 'opened' });

    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.pr_number === 1);
    expect(task).toBeDefined();
    // Agent has reputation 0.1 < minReputation 0.5, so task stays pending
    expect(task!.status).toBe('pending');
  });

  it('blacklist filtering excludes blacklisted agent user', async () => {
    const { user, apiKey } = await ctx.createUser({ name: 'blocked-user' });
    const agent = await ctx.createAgent(user.id as string, { status: 'online' });
    await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
    });

    const agentId = agent.id as string;
    const wsReq = new Request(`https://api.opencara.dev/ws/agent/${agentId}?token=${apiKey}`, {
      headers: { Upgrade: 'websocket' },
    });
    await ctx.workerFetch(wsReq);

    ctx.github.options.reviewConfigs = {
      'test-owner/test-repo': [
        'version: 1',
        'prompt: "Review this PR"',
        'reviewer:',
        '  blacklist:',
        '    - user: blocked-user',
      ].join('\n'),
    };

    await sendPRWebhook({ action: 'opened' });

    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.pr_number === 1);
    expect(task).toBeDefined();
    // Agent's user is blacklisted, so task stays pending
    expect(task!.status).toBe('pending');
  });

  it('reviewCount=3 reserves 1 synthesizer and distributes to 3 reviewers (needs 4 agents)', async () => {
    // Create 4 online agents: 1 will be reserved as synthesizer, 3 will review
    const agents: Array<{ agentId: string; pair: ReturnType<typeof ctx.getLastWSPair> }> = [];
    await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
    });

    for (let i = 0; i < 4; i++) {
      const { user, apiKey } = await ctx.createUser({ name: `user${i}` });
      const agent = await ctx.createAgent(user.id as string, {
        status: 'online',
        reputation_score: 0.5 + i * 0.1,
      });
      const agentId = agent.id as string;
      const wsReq = new Request(`https://api.opencara.dev/ws/agent/${agentId}?token=${apiKey}`, {
        headers: { Upgrade: 'websocket' },
      });
      await ctx.workerFetch(wsReq);
      agents.push({ agentId, pair: ctx.getLastWSPair() });
    }

    ctx.github.options.reviewConfigs = {
      'test-owner/test-repo': [
        'version: 1',
        'prompt: "Review this PR"',
        'agents:',
        '  review_count: 3',
      ].join('\n'),
    };

    await sendPRWebhook({ action: 'opened' });

    // 3 agents should receive review_request, 1 (highest rep) is reserved as synthesizer
    let reviewRequestCount = 0;
    for (const { pair } of agents) {
      const messages = pair!.client.getReceivedParsed<{ type: string }>();
      if (messages.some((m) => m.type === 'review_request')) {
        reviewRequestCount++;
      }
    }
    expect(reviewRequestCount).toBe(3);
  });
});
