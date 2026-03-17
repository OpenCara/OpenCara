import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Task Timeout DO Alarm', () => {
  let ctx: E2EContext;

  beforeEach(() => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(ctx.supabase.client as ReturnType<typeof createSupabaseClient>);
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  /** Insert a review task directly into the mock DB. */
  function insertTask(overrides?: Record<string, unknown>) {
    const taskId = overrides?.id as string ?? crypto.randomUUID();
    const task: Record<string, unknown> = {
      id: taskId,
      project_id: 'proj-1',
      pr_number: 1,
      pr_url: 'https://github.com/test-owner/test-repo/pull/1',
      status: 'pending',
      timeout_at: new Date(Date.now() + 600_000).toISOString(),
      config_json: {},
      created_at: new Date().toISOString(),
      ...overrides,
    };
    ctx.supabase.getTable('review_tasks').push(task);
    return { taskId, task };
  }

  /** Set up the TaskTimeout DO for a given task. */
  async function setupTimeoutDO(taskId: string, overrides?: Record<string, unknown>) {
    const doId = ctx.taskTimeoutNS.idFromName(taskId);
    const stub = ctx.taskTimeoutNS.get(doId);
    await stub.fetch(
      new Request('https://internal/set-timeout', {
        method: 'POST',
        body: JSON.stringify({
          taskId,
          timeoutMs: 60000,
          reviewCount: 1,
          installationId: 12345,
          owner: 'test-owner',
          repo: 'test-repo',
          prNumber: 1,
          prompt: '',
          ...overrides,
        }),
      }),
    );
  }

  it('pending task at timeout → status=timeout', async () => {
    const { taskId } = insertTask({ status: 'pending' });
    await setupTimeoutDO(taskId);

    await ctx.fireTimeoutAlarm(taskId);

    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.id === taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('timeout');
  });

  it('reviewing task with no completed results → status=timeout', async () => {
    const { taskId } = insertTask({ status: 'reviewing' });
    await setupTimeoutDO(taskId);

    await ctx.fireTimeoutAlarm(taskId);

    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.id === taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('timeout');
  });

  it('reviewing task with partial results → status=summarizing', async () => {
    const { taskId } = insertTask({ status: 'reviewing' });

    // Create reviewer agent (participated in the review)
    const { user: reviewerUser, apiKey: _reviewerKey } = await ctx.createUser({ name: 'reviewer1' });
    const reviewerAgent = await ctx.createAgent(reviewerUser.id as string, { status: 'online' });
    const reviewerAgentId = reviewerAgent.id as string;

    // Create summary agent (a different online agent to be selected for summarization)
    const { user: summaryUser, apiKey: summaryKey } = await ctx.createUser({ name: 'summarizer1' });
    const summaryAgent = await ctx.createAgent(summaryUser.id as string, { status: 'online' });
    const summaryAgentId = summaryAgent.id as string;

    // Connect summary agent via WS so push-summary doesn't fail with 503
    const wsReq = new Request(
      `https://api.opencara.dev/ws/agent/${summaryAgentId}?token=${summaryKey}`,
      { headers: { Upgrade: 'websocket' } },
    );
    await ctx.workerFetch(wsReq);

    // Insert a completed review result referencing the reviewer agent
    ctx.supabase.getTable('review_results').push({
      id: crypto.randomUUID(),
      review_task_id: taskId,
      agent_id: reviewerAgentId,
      status: 'completed',
      review_text: 'Looks good',
      verdict: 'approve',
      created_at: new Date().toISOString(),
    });
    await setupTimeoutDO(taskId, { reviewCount: 3 });

    await ctx.fireTimeoutAlarm(taskId);

    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.id === taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('summarizing');
  });

  it('already completed task → no change', async () => {
    const { taskId } = insertTask({ status: 'completed' });
    await setupTimeoutDO(taskId);

    await ctx.fireTimeoutAlarm(taskId);

    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.id === taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('completed');
  });

  it('timeout posts a PR comment', async () => {
    const { taskId } = insertTask({ status: 'pending' });
    await setupTimeoutDO(taskId);

    await ctx.fireTimeoutAlarm(taskId);

    expect(ctx.github.postedComments.length).toBeGreaterThanOrEqual(1);
    const comment = ctx.github.postedComments.find(
      (c) => c.owner === 'test-owner' && c.repo === 'test-repo' && c.prNumber === 1,
    );
    expect(comment).toBeDefined();
    expect(comment!.body).toContain('OpenCara');
  });

  it('idempotent: double alarm → same result', async () => {
    const { taskId } = insertTask({ status: 'pending' });
    await setupTimeoutDO(taskId);

    await ctx.fireTimeoutAlarm(taskId);
    await ctx.fireTimeoutAlarm(taskId);

    const tasks = ctx.supabase.getTable('review_tasks');
    const task = tasks.find((t) => t.id === taskId);
    expect(task).toBeDefined();
    expect(task!.status).toBe('timeout');

    // Only one comment posted (second alarm sees status=timeout, not pending/reviewing)
    const comments = ctx.github.postedComments.filter(
      (c) => c.owner === 'test-owner' && c.repo === 'test-repo' && c.prNumber === 1,
    );
    expect(comments.length).toBe(1);
  });
});
