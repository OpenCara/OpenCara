import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Pending Task Pickup on Agent Connect', () => {
  let ctx: E2EContext;

  beforeEach(() => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(ctx.supabase.client as ReturnType<typeof createSupabaseClient>);
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  /** Insert a pending review task with required relationships. */
  function insertPendingTask(overrides?: Record<string, unknown>) {
    const projectId = 'proj-pending';
    // Ensure the project exists
    const projects = ctx.supabase.getTable('projects');
    if (!projects.find((p) => p.id === projectId)) {
      projects.push({
        id: projectId,
        github_installation_id: 12345,
        owner: 'test-owner',
        repo: 'test-repo',
        created_at: new Date().toISOString(),
      });
    }

    const taskId = (overrides?.id as string) ?? crypto.randomUUID();
    const task: Record<string, unknown> = {
      id: taskId,
      project_id: projectId,
      pr_number: 1,
      pr_url: 'https://github.com/test-owner/test-repo/pull/1',
      status: 'pending',
      timeout_at: new Date(Date.now() + 600_000).toISOString(),
      config_json: {
        prompt: 'Review this PR',
        reviewCount: 1,
        timeout: '10m',
        diffUrl: 'https://github.com/test-owner/test-repo/pull/1.diff',
        baseRef: 'main',
        headRef: 'feature-branch',
        installationId: 12345,
      },
      created_at: new Date().toISOString(),
      ...overrides,
    };
    ctx.supabase.getTable('review_tasks').push(task);
    return { taskId, task };
  }

  /** Connect an agent via WebSocket and return the pair. */
  async function connectAgent(agentOverrides?: Record<string, unknown>) {
    const { user, apiKey } = await ctx.createUser();
    const agent = await ctx.createAgent(user.id as string, {
      status: 'online',
      ...agentOverrides,
    });
    const agentId = agent.id as string;

    const wsReq = new Request(
      `https://api.opencara.dev/ws/agent/${agentId}?token=${apiKey}`,
      { headers: { Upgrade: 'websocket' } },
    );
    await ctx.workerFetch(wsReq);

    const pair = ctx.getLastWSPair()!;
    return { user, apiKey, agent, agentId, pair };
  }

  it('agent connects → pending task picked up', async () => {
    const { taskId } = insertPendingTask();

    const { pair } = await connectAgent();

    // Agent should receive the review_request
    const messages = pair.client.getReceivedParsed<{ type: string; taskId?: string }>();
    const reviewReq = messages.find((m) => m.type === 'review_request');
    expect(reviewReq).toBeDefined();
    expect(reviewReq!.taskId).toBe(taskId);

    // Task status should be updated to reviewing
    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.id === taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('reviewing');
  });

  it('expired task skipped', async () => {
    // Task with timeout_at in the past
    insertPendingTask({
      timeout_at: new Date(Date.now() - 60_000).toISOString(),
    });

    const { pair } = await connectAgent();

    const messages = pair.client.getReceivedParsed<{ type: string }>();
    const reviewReq = messages.find((m) => m.type === 'review_request');
    expect(reviewReq).toBeUndefined();
  });

  it('task with < 30s remaining skipped', async () => {
    // Task with only 20 seconds remaining
    insertPendingTask({
      timeout_at: new Date(Date.now() + 20_000).toISOString(),
    });

    const { pair } = await connectAgent();

    const messages = pair.client.getReceivedParsed<{ type: string }>();
    const reviewReq = messages.find((m) => m.type === 'review_request');
    expect(reviewReq).toBeUndefined();
  });

  it('reconnect with existing in-flight tasks → no pickup', async () => {
    const { taskId } = insertPendingTask();

    const { agentId, apiKey } = await connectAgent();

    // Manually set in-flight tasks to simulate reconnect with in-flight work
    const state = ctx.agentConnectionNS.getState(agentId)!;
    await state.storage.put('inFlightTaskIds', ['existing-task-id']);

    // Advance time past debounce window
    await state.storage.put('connectedAt', new Date(Date.now() - 6_000).toISOString());

    // Reconnect
    const wsReq = new Request(
      `https://api.opencara.dev/ws/agent/${agentId}?token=${apiKey}`,
      { headers: { Upgrade: 'websocket' } },
    );
    await ctx.workerFetch(wsReq);

    const secondPair = ctx.getLastWSPair()!;

    // Should NOT receive a review_request for the pending task
    // because reconnecting with in-flight tasks skips pickup
    const messages = secondPair.client.getReceivedParsed<{ type: string; taskId?: string }>();
    const reviewReq = messages.find(
      (m) => m.type === 'review_request' && m.taskId === taskId,
    );
    expect(reviewReq).toBeUndefined();
  });

  it('reconnect without in-flight tasks → picks up pending tasks', async () => {
    // First: connect agent (no pending tasks yet)
    const { agentId, apiKey } = await connectAgent();

    // Now insert a pending task
    const { taskId } = insertPendingTask();

    // Set in-flight to empty and advance past debounce
    const state = ctx.agentConnectionNS.getState(agentId)!;
    await state.storage.put('inFlightTaskIds', []);
    await state.storage.put('connectedAt', new Date(Date.now() - 6_000).toISOString());

    // Reconnect
    const wsReq = new Request(
      `https://api.opencara.dev/ws/agent/${agentId}?token=${apiKey}`,
      { headers: { Upgrade: 'websocket' } },
    );
    await ctx.workerFetch(wsReq);

    const secondPair = ctx.getLastWSPair()!;

    // Should receive a review_request for the pending task
    const messages = secondPair.client.getReceivedParsed<{ type: string; taskId?: string }>();
    const reviewReq = messages.find(
      (m) => m.type === 'review_request' && m.taskId === taskId,
    );
    expect(reviewReq).toBeDefined();

    // Task status should be updated to reviewing
    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.id === taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('reviewing');
  });
});
