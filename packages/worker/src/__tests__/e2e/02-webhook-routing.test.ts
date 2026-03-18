import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';
import {
  buildPullRequestPayload,
  buildIssueCommentPayload,
  buildInstallationPayload,
} from './helpers/webhook-builder.js';

// Mock only the Supabase client factory — everything else runs for real
vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('Webhook Event Routing (E2E)', () => {
  let ctx: E2EContext;

  beforeEach(() => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(ctx.supabase.client as never);
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  async function sendWebhook(event: string, payload: unknown): Promise<Response> {
    const body = JSON.stringify(payload);
    const sig = await ctx.signWebhook(body);
    return ctx.workerFetch(
      new Request('https://api.opencara.dev/webhook/github', {
        method: 'POST',
        headers: {
          'X-Hub-Signature-256': sig,
          'X-GitHub-Event': event,
          'Content-Type': 'application/json',
        },
        body,
      }),
    );
  }

  it('pull_request opened returns 200', async () => {
    const payload = buildPullRequestPayload({ action: 'opened' });
    const res = await sendWebhook('pull_request', payload);
    expect(res.status).toBe(200);
  });

  it('pull_request synchronize returns 200', async () => {
    const payload = buildPullRequestPayload({ action: 'synchronize' });
    const res = await sendWebhook('pull_request', payload);
    expect(res.status).toBe(200);
  });

  it('pull_request closed returns 200, no review_tasks created', async () => {
    const payload = buildPullRequestPayload({ action: 'closed' });
    const res = await sendWebhook('pull_request', payload);
    expect(res.status).toBe(200);
    // closed is not in the default trigger.on list ['opened'], so no tasks are created
    expect(ctx.supabase.getTable('review_tasks')).toHaveLength(0);
  });

  it('issues opened returns 200, no review_tasks created', async () => {
    const payload = {
      action: 'opened',
      installation: { id: 12345 },
      repository: { owner: { login: 'test-owner' }, name: 'test-repo' },
      issue: { number: 1 },
    };
    const res = await sendWebhook('issues', payload);
    expect(res.status).toBe(200);
    expect(ctx.supabase.getTable('review_tasks')).toHaveLength(0);
  });

  it('installation created returns 200', async () => {
    const payload = buildInstallationPayload('created');
    const res = await sendWebhook('installation', payload);
    expect(res.status).toBe(200);
  });

  it('installation deleted returns 200', async () => {
    const payload = buildInstallationPayload('deleted');
    const res = await sendWebhook('installation', payload);
    expect(res.status).toBe(200);
  });

  it('unknown event returns 200', async () => {
    const payload = { action: 'created', data: {} };
    const res = await sendWebhook('unknown_event', payload);
    expect(res.status).toBe(200);
  });

  it('issue_comment "/opencara review" from OWNER on PR triggers review task', async () => {
    const payload = buildIssueCommentPayload({
      commentBody: '/opencara review',
      authorAssociation: 'OWNER',
      isPR: true,
    });
    const res = await sendWebhook('issue_comment', payload);
    expect(res.status).toBe(200);

    // A review_task should have been created
    const tasks = ctx.supabase.getTable('review_tasks');
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('issue_comment with non-matching body creates no task', async () => {
    const payload = buildIssueCommentPayload({
      commentBody: 'Great work!',
      authorAssociation: 'OWNER',
      isPR: true,
    });
    const res = await sendWebhook('issue_comment', payload);
    expect(res.status).toBe(200);
    expect(ctx.supabase.getTable('review_tasks')).toHaveLength(0);
  });

  it('issue_comment from untrusted user (NONE) creates no task', async () => {
    const payload = buildIssueCommentPayload({
      commentBody: '/opencara review',
      authorAssociation: 'NONE',
      isPR: true,
    });
    const res = await sendWebhook('issue_comment', payload);
    expect(res.status).toBe(200);
    expect(ctx.supabase.getTable('review_tasks')).toHaveLength(0);
  });
});
