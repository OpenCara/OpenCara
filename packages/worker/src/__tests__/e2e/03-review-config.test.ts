import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';
import { buildPullRequestPayload } from './helpers/webhook-builder.js';

// Mock only the Supabase client factory — everything else runs for real
vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

const VALID_REVIEW_YAML = `version: 1
prompt: "Review this PR"
trigger:
  on: [opened, synchronize]
  comment: /opencara review
  skip: [draft]
agents:
  review_count: 1
  preferred_models: []
  preferred_tools: []
  min_reputation: 0
reviewer:
  whitelist: []
  blacklist: []
summarizer:
  whitelist: []
  blacklist: []
timeout: 10m
`;

describe('Review Config Loading (E2E)', () => {
  let ctx: E2EContext;

  beforeEach(() => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(ctx.supabase.client as never);
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  async function sendPrWebhook(
    overrides?: Parameters<typeof buildPullRequestPayload>[0],
  ): Promise<Response> {
    const payload = buildPullRequestPayload(overrides);
    const body = JSON.stringify(payload);
    const sig = await ctx.signWebhook(body);
    return ctx.workerFetch(
      new Request('https://api.opencara.dev/webhook/github', {
        method: 'POST',
        headers: {
          'X-Hub-Signature-256': sig,
          'X-GitHub-Event': 'pull_request',
          'Content-Type': 'application/json',
        },
        body,
      }),
    );
  }

  it('valid .review.yml creates a task', async () => {
    ctx.github.options.reviewConfigs = { 'test-owner/test-repo': VALID_REVIEW_YAML };
    // Ensure a project exists
    await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
    });

    const res = await sendPrWebhook({ action: 'opened' });
    expect(res.status).toBe(200);

    const tasks = ctx.supabase.getTable('review_tasks');
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('no .review.yml uses DEFAULT_REVIEW_CONFIG and creates a task', async () => {
    // reviewConfigs not set — mock returns 404, triggering default config
    await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
    });

    const res = await sendPrWebhook({ action: 'opened' });
    expect(res.status).toBe(200);

    // Default config has trigger.on: ['opened'], so task is created
    const tasks = ctx.supabase.getTable('review_tasks');
    expect(tasks.length).toBeGreaterThanOrEqual(1);
  });

  it('malformed YAML posts error comment and creates no task', async () => {
    ctx.github.options.reviewConfigs = { 'test-owner/test-repo': '{{{{not valid yaml' };
    await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
    });

    const res = await sendPrWebhook({ action: 'opened' });
    expect(res.status).toBe(200);

    // An error comment should be posted
    expect(ctx.github.postedComments.length).toBeGreaterThanOrEqual(1);
    const comment = ctx.github.postedComments[0];
    expect(comment.body).toContain('Failed to parse');

    // No task should be created because parseError aborts
    expect(ctx.supabase.getTable('review_tasks')).toHaveLength(0);
  });

  it('draft PR with skip: [draft] creates no task', async () => {
    const yamlWithDraftSkip = `version: 1
prompt: "Review this PR"
trigger:
  on: [opened]
  comment: /opencara review
  skip: [draft]
agents:
  review_count: 1
timeout: 10m
`;
    ctx.github.options.reviewConfigs = { 'test-owner/test-repo': yamlWithDraftSkip };
    await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
    });

    const res = await sendPrWebhook({ action: 'opened', pr: { draft: true } });
    expect(res.status).toBe(200);
    expect(ctx.supabase.getTable('review_tasks')).toHaveLength(0);
  });

  it('PR with label "skip-review" and skip: [label:skip-review] creates no task', async () => {
    const yamlWithLabelSkip = `version: 1
prompt: "Review this PR"
trigger:
  on: [opened]
  comment: /opencara review
  skip: ["label:skip-review"]
agents:
  review_count: 1
timeout: 10m
`;
    ctx.github.options.reviewConfigs = { 'test-owner/test-repo': yamlWithLabelSkip };
    await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
    });

    const res = await sendPrWebhook({
      action: 'opened',
      pr: { labels: [{ name: 'skip-review' }] },
    });
    expect(res.status).toBe(200);
    expect(ctx.supabase.getTable('review_tasks')).toHaveLength(0);
  });

  it('branch matching skip pattern creates no task', async () => {
    const yamlWithBranchSkip = `version: 1
prompt: "Review this PR"
trigger:
  on: [opened]
  comment: /opencara review
  skip: ["branch:release/*"]
agents:
  review_count: 1
timeout: 10m
`;
    ctx.github.options.reviewConfigs = { 'test-owner/test-repo': yamlWithBranchSkip };
    await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
    });

    const res = await sendPrWebhook({
      action: 'opened',
      pr: { head: { ref: 'release/v1.0' } },
    });
    expect(res.status).toBe(200);
    expect(ctx.supabase.getTable('review_tasks')).toHaveLength(0);
  });

  it('action "closed" not in trigger.on creates no task', async () => {
    const yamlOpenOnly = `version: 1
prompt: "Review this PR"
trigger:
  on: [opened, synchronize]
  comment: /opencara review
  skip: []
agents:
  review_count: 1
timeout: 10m
`;
    ctx.github.options.reviewConfigs = { 'test-owner/test-repo': yamlOpenOnly };
    await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
    });

    const res = await sendPrWebhook({ action: 'closed' });
    expect(res.status).toBe(200);
    expect(ctx.supabase.getTable('review_tasks')).toHaveLength(0);
  });

  it('config with agents.review_count: 3 sets reviewCount=3 in config_json', async () => {
    const yamlWithCount3 = `version: 1
prompt: "Review this PR"
trigger:
  on: [opened]
  comment: /opencara review
  skip: []
agents:
  review_count: 3
timeout: 10m
`;
    ctx.github.options.reviewConfigs = { 'test-owner/test-repo': yamlWithCount3 };
    await ctx.createProject({
      owner: 'test-owner',
      repo: 'test-repo',
      github_installation_id: 12345,
    });

    const res = await sendPrWebhook({ action: 'opened' });
    expect(res.status).toBe(200);

    const tasks = ctx.supabase.getTable('review_tasks');
    expect(tasks.length).toBeGreaterThanOrEqual(1);
    const configJson = tasks[0].config_json as { reviewCount: number };
    expect(configJson.reviewCount).toBe(3);
  });
});
