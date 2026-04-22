/**
 * Tests for the PR-scoped base_ref invariant at the webhook boundary.
 *
 * Context: #776 — every PR-scoped task must carry a non-empty base_ref so the
 * CLI can take the local `git diff` fast path. The DataStore raises
 * MissingBaseRefError when that invariant is violated; the webhook handler
 * must surface that as 400 (not 503 or 500) so GitHub does not retry a
 * structurally broken payload.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import type { ReviewConfig, OpenCaraConfig } from '@opencara/shared';
import { DEFAULT_OPENCARA_CONFIG, DEFAULT_REVIEW_CONFIG } from '@opencara/shared';
import type { GitHubService, PrDetails, IssueDetails } from '../github/service.js';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import { resetTimeoutThrottle } from '../routes/tasks.js';
import { MissingBaseRefError } from '../errors.js';

const WEBHOOK_SECRET = 'test-webhook-secret';

function getMockEnv() {
  return {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: 'unused-in-mock',
    WEB_URL: 'https://test.opencara.com',
  };
}

async function signPayload(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

class StubGitHubService implements Partial<GitHubService> {
  async getInstallationToken(): Promise<string> {
    return 'ghs_mock';
  }
  async postPrComment(): Promise<{ html_url: string; comment_id: number }> {
    return { html_url: '', comment_id: 0 };
  }
  async getCommentReactions(): Promise<Array<{ user_id: number; content: string }>> {
    return [];
  }
  async fetchPrDetails(): Promise<PrDetails | null> {
    return {
      number: 42,
      html_url: '',
      diff_url: '',
      base: { ref: 'main' },
      head: { ref: 'feat', sha: 'abc' },
      user: { login: 'octocat' },
      draft: false,
      labels: [],
    };
  }
  async loadReviewConfig(): Promise<{ config: ReviewConfig; parseError: boolean }> {
    return { config: DEFAULT_REVIEW_CONFIG, parseError: false };
  }
  async loadOpenCaraConfig(): Promise<{ config: OpenCaraConfig; parseError: boolean }> {
    return { config: DEFAULT_OPENCARA_CONFIG, parseError: false };
  }
  async fetchPrReviewComments(): Promise<string> {
    return '';
  }
  async updateIssue(): Promise<void> {}
  async fetchIssueBody(): Promise<string | null> {
    return null;
  }
  async fetchIssueDetails(_o: string, _r: string, number: number): Promise<IssueDetails | null> {
    return {
      number,
      html_url: '',
      title: 'test',
      body: 'body',
      user: { login: 'alice' },
    };
  }
  async createIssue(): Promise<number> {
    return 0;
  }
  async listIssueComments(): Promise<Array<{ id: number; body: string }>> {
    return [];
  }
  async createIssueComment(): Promise<number> {
    return 0;
  }
  async updateIssueComment(): Promise<void> {}
}

function makePRPayload(overrides: Record<string, unknown> = {}) {
  return {
    action: 'opened',
    installation: { id: 999 },
    repository: { owner: { login: 'acme' }, name: 'widget' },
    pull_request: {
      number: 42,
      html_url: 'https://github.com/acme/widget/pull/42',
      diff_url: 'https://github.com/acme/widget/pull/42.diff',
      base: { ref: 'main' },
      head: { ref: 'feat/test', sha: 'abc123' },
      draft: false,
      labels: [],
    },
    ...overrides,
  };
}

async function sendWebhook(
  app: ReturnType<typeof createApp>,
  event: string,
  payload: unknown,
  env: ReturnType<typeof getMockEnv>,
) {
  const body = JSON.stringify(payload);
  const signature = await signPayload(body, WEBHOOK_SECRET);
  return app.request(
    '/webhook/github',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Hub-Signature-256': signature,
        'X-GitHub-Event': event,
      },
      body,
    },
    env,
  );
}

describe('Webhook base_ref invariant — #776', () => {
  let store: MemoryDataStore;
  let github: StubGitHubService;
  let app: ReturnType<typeof createApp>;
  let env: ReturnType<typeof getMockEnv>;

  beforeEach(() => {
    resetTimeoutThrottle();
    resetRateLimits();
    store = new MemoryDataStore();
    github = new StubGitHubService();
    app = createApp(store, github as unknown as GitHubService);
    env = getMockEnv();
  });

  it('returns 400 (not 500/503) when the store raises MissingBaseRefError', async () => {
    // Simulate an upstream regression where a PR-scoped task reaches the
    // store with empty base_ref. Under correct behavior every PR webhook
    // path threads base.ref through to the task; this guard catches a
    // future regression before it lands empty base_ref in D1.
    store.createTaskIfNotExists = async (task) => {
      throw new MissingBaseRefError({
        id: task.id,
        owner: task.owner,
        repo: task.repo,
        pr_number: task.pr_number,
        feature: task.feature,
      });
    };

    const res = await sendWebhook(app, 'pull_request', makePRPayload(), env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('INVALID_REQUEST');
    expect(body.error.message).toContain('base_ref');
    expect(body.error.message).toContain('acme/widget#42');
  });

  it('re-throws non-invariant errors (does not swallow into 400)', async () => {
    store.createTaskIfNotExists = async () => {
      throw new Error('D1 write failure');
    };
    const res = await sendWebhook(app, 'pull_request', makePRPayload(), env);
    // Non-invariant errors fall through to Hono's default handler (not 400).
    // The point is that a generic error is NOT mapped to 400.
    expect(res.status).not.toBe(400);
    expect(res.status).toBeGreaterThanOrEqual(500);
  });

  it('returns 200 on the normal PR-opened path (sanity — guard does not fire)', async () => {
    const res = await sendWebhook(app, 'pull_request', makePRPayload(), env);
    expect(res.status).toBe(200);
    const tasks = await store.listTasks();
    expect(tasks.length).toBeGreaterThan(0);
    for (const t of tasks) {
      if (t.pr_number > 0) {
        expect(t.base_ref).toBe('main');
      }
    }
  });
});
