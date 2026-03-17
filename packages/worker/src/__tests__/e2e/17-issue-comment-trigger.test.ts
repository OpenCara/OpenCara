import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';
import { buildIssueCommentPayload } from './helpers/webhook-builder.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Issue Comment Trigger (/opencara review)', () => {
  let ctx: E2EContext;

  beforeEach(() => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(ctx.supabase.client as ReturnType<typeof createSupabaseClient>);
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  /** Send an issue_comment webhook. */
  async function sendCommentWebhook(
    overrides?: Parameters<typeof buildIssueCommentPayload>[0],
  ) {
    const payload = buildIssueCommentPayload(overrides);
    const body = JSON.stringify(payload);
    const sig = await ctx.signWebhook(body);
    const req = new Request('https://api.opencara.dev/webhook/github', {
      method: 'POST',
      headers: {
        'X-Hub-Signature-256': sig,
        'X-GitHub-Event': 'issue_comment',
        'Content-Type': 'application/json',
      },
      body,
    });
    return ctx.workerFetch(req);
  }

  /** Set up project and an online connected agent. */
  async function setupWithAgent() {
    const { user, apiKey } = await ctx.createUser();
    const agent = await ctx.createAgent(user.id as string, { status: 'online' });
    await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
    });

    const agentId = agent.id as string;
    const wsReq = new Request(
      `https://api.opencara.dev/ws/agent/${agentId}?token=${apiKey}`,
      { headers: { Upgrade: 'websocket' } },
    );
    await ctx.workerFetch(wsReq);
    return { user, apiKey, agent, agentId };
  }

  it('/opencara review from OWNER on PR → task created', async () => {
    await setupWithAgent();

    const res = await sendCommentWebhook({
      commentBody: '/opencara review',
      authorAssociation: 'OWNER',
    });
    expect(res.status).toBe(200);

    const tasks = ctx.supabase.getTable('review_tasks');
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('/opencara review from CONTRIBUTOR on PR → task created', async () => {
    await setupWithAgent();

    const res = await sendCommentWebhook({
      commentBody: '/opencara review',
      authorAssociation: 'CONTRIBUTOR',
    });
    expect(res.status).toBe(200);

    const tasks = ctx.supabase.getTable('review_tasks');
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('comment from non-trusted user (NONE) → no task', async () => {
    await setupWithAgent();

    const res = await sendCommentWebhook({
      commentBody: '/opencara review',
      authorAssociation: 'NONE',
    });
    expect(res.status).toBe(200);

    const tasks = ctx.supabase.getTable('review_tasks');
    expect(tasks.length).toBe(0);
  });

  it('custom trigger command from config → task created', async () => {
    await setupWithAgent();

    // Set custom trigger command in review config
    ctx.github.options.reviewConfigs = {
      'test-owner/test-repo': [
        'version: 1',
        'prompt: "Review this PR"',
        'trigger:',
        '  comment: /review-me',
      ].join('\n'),
    };

    const res = await sendCommentWebhook({
      commentBody: '/review-me',
      authorAssociation: 'OWNER',
    });
    expect(res.status).toBe(200);

    const tasks = ctx.supabase.getTable('review_tasks');
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('comment on non-PR issue → no task', async () => {
    await setupWithAgent();

    const res = await sendCommentWebhook({
      isPR: false,
      commentBody: '/opencara review',
      authorAssociation: 'OWNER',
    });
    expect(res.status).toBe(200);

    const tasks = ctx.supabase.getTable('review_tasks');
    expect(tasks.length).toBe(0);
  });
});
