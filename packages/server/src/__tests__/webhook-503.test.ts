/**
 * Tests for webhook 503 responses on transient failures.
 *
 * Verifies that transient/retriable failures (token fetch, config parse, store write,
 * PR details fetch) return 503 Service Unavailable so GitHub retries, while intentional
 * skips (draft PRs, action not in trigger list, no installation) return 200 OK.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_REVIEW_CONFIG, DEFAULT_OPENCARA_CONFIG } from '@opencara/shared';
import type { ReviewConfig, OpenCaraConfig } from '@opencara/shared';
import type { GitHubService, PrDetails, IssueDetails } from '../github/service.js';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import { resetTimeoutThrottle } from '../routes/tasks.js';

// ── Helpers ────────────────────────────────────────────────────

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

/**
 * Configurable mock GitHubService for testing failure modes.
 */
class FailableGitHubService implements GitHubService {
  tokenError: Error | null = null;
  parseError = false;
  configOverride: ReviewConfig | null = null;
  openCaraConfigOverride: OpenCaraConfig | null = null;
  fetchPrResult: PrDetails | null = {
    number: 1,
    html_url: 'https://github.com/acme/widget/pull/1',
    diff_url: 'https://github.com/acme/widget/pull/1.diff',
    base: { ref: 'main' },
    head: { ref: 'feat/test', sha: 'abc123' },
    user: { login: 'pr-author' },
    draft: false,
    labels: [],
  };

  async getInstallationToken(_installationId: number): Promise<string> {
    if (this.tokenError) throw this.tokenError;
    return 'ghs_mock_token';
  }

  async postPrComment(
    _owner: string,
    _repo: string,
    _prNumber: number,
    _body: string,
    _token: string,
  ): Promise<{ html_url: string; comment_id: number }> {
    return { html_url: 'https://github.com/test/repo/pull/1#comment-mock', comment_id: 12345 };
  }

  async getCommentReactions(): Promise<Array<{ user_id: number; content: string }>> {
    return [];
  }

  async fetchPrDetails(
    _owner: string,
    _repo: string,
    _prNumber: number,
  ): Promise<PrDetails | null> {
    return this.fetchPrResult;
  }

  async loadReviewConfig(
    _owner: string,
    _repo: string,
    _baseRef: string,
    _prNumber: number,
    _token: string,
  ): Promise<{ config: ReviewConfig; parseError: boolean }> {
    return { config: this.configOverride ?? DEFAULT_REVIEW_CONFIG, parseError: this.parseError };
  }

  async loadOpenCaraConfig(
    _owner: string,
    _repo: string,
    _ref: string,
    _token: string,
  ): Promise<{ config: OpenCaraConfig; parseError: boolean }> {
    if (this.openCaraConfigOverride) {
      return { config: this.openCaraConfigOverride, parseError: this.parseError };
    }
    // Build from configOverride/default for backward compat
    const review = this.configOverride ?? DEFAULT_REVIEW_CONFIG;
    return {
      config: { ...DEFAULT_OPENCARA_CONFIG, review },
      parseError: this.parseError,
    };
  }

  async fetchPrReviewComments(): Promise<string> {
    return '';
  }
  async updateIssue(): Promise<void> {}
  async fetchIssueBody(): Promise<string | null> {
    return null;
  }
  async fetchIssueDetails(
    _owner: string,
    _repo: string,
    number: number,
  ): Promise<IssueDetails | null> {
    return {
      number,
      html_url: `https://github.com/acme/widget/issues/${number}`,
      title: `Test issue #${number}`,
      body: 'Test body',
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

function makeCommentPayload(
  body: string,
  association = 'OWNER',
  overrides: Record<string, unknown> = {},
) {
  return {
    action: 'created',
    installation: { id: 999 },
    repository: { owner: { login: 'acme' }, name: 'widget' },
    issue: {
      number: 42,
      pull_request: { url: 'https://api.github.com/repos/acme/widget/pulls/42' },
    },
    comment: {
      body,
      user: { login: 'octocat' },
      author_association: association,
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

// ── Tests ──────────────────────────────────────────────────────

describe('Webhook 503 — transient failure responses', () => {
  let store: MemoryDataStore;
  let github: FailableGitHubService;
  let app: ReturnType<typeof createApp>;
  let env: ReturnType<typeof getMockEnv>;

  beforeEach(() => {
    resetTimeoutThrottle();
    resetRateLimits();
    store = new MemoryDataStore();
    github = new FailableGitHubService();
    app = createApp(store, github);
    env = getMockEnv();
  });

  // ── pull_request handler ───────────────────────────────────

  describe('pull_request handler', () => {
    it('returns 503 when installation token fetch fails', async () => {
      github.tokenError = new Error('GitHub API timeout');
      const res = await sendWebhook(app, 'pull_request', makePRPayload(), env);
      expect(res.status).toBe(503);
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(0);
    });

    it('returns 503 when .opencara.toml has a parse error', async () => {
      github.parseError = true;
      const res = await sendWebhook(app, 'pull_request', makePRPayload(), env);
      expect(res.status).toBe(503);
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(0);
    });

    it('returns 503 when store.createTaskIfNotExists throws', async () => {
      // Make the store throw on write
      const originalCreate = store.createTaskIfNotExists.bind(store);
      store.createTaskIfNotExists = async () => {
        void originalCreate;
        throw new Error('D1 write failure');
      };
      const res = await sendWebhook(app, 'pull_request', makePRPayload(), env);
      expect(res.status).toBe(503);
    });

    it('returns 200 when action is not in trigger.events (intentional skip)', async () => {
      const payload = makePRPayload({ action: 'closed' });
      const res = await sendWebhook(app, 'pull_request', payload, env);
      expect(res.status).toBe(200);
    });

    it('returns 200 when PR is a draft (intentional skip)', async () => {
      const payload = makePRPayload({
        pull_request: {
          number: 42,
          html_url: 'https://github.com/acme/widget/pull/42',
          diff_url: 'https://github.com/acme/widget/pull/42.diff',
          base: { ref: 'main' },
          head: { ref: 'feat/test', sha: 'abc123' },
          draft: true,
          labels: [],
        },
      });
      const res = await sendWebhook(app, 'pull_request', payload, env);
      expect(res.status).toBe(200);
    });

    it('returns 200 when no installation is present (intentional skip)', async () => {
      const payload = makePRPayload({ installation: undefined });
      const res = await sendWebhook(app, 'pull_request', payload, env);
      expect(res.status).toBe(200);
    });

    it('returns 200 on successful task creation', async () => {
      const res = await sendWebhook(app, 'pull_request', makePRPayload(), env);
      expect(res.status).toBe(200);
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
    });
  });

  // ── issue_comment handler ──────────────────────────────────

  describe('issue_comment handler', () => {
    it('returns 503 when installation token fetch fails', async () => {
      github.tokenError = new Error('GitHub API timeout');
      const payload = makeCommentPayload('/opencara review');
      const res = await sendWebhook(app, 'issue_comment', payload, env);
      expect(res.status).toBe(503);
    });

    it('returns 503 when PR details fetch fails', async () => {
      github.fetchPrResult = null;
      const payload = makeCommentPayload('/opencara review');
      const res = await sendWebhook(app, 'issue_comment', payload, env);
      expect(res.status).toBe(503);
    });

    it('returns 503 when .opencara.toml has a parse error', async () => {
      github.parseError = true;
      const payload = makeCommentPayload('/opencara review');
      const res = await sendWebhook(app, 'issue_comment', payload, env);
      expect(res.status).toBe(503);
    });

    it('returns 503 when store.createTaskIfNotExists throws', async () => {
      store.createTaskIfNotExists = async () => {
        throw new Error('D1 write failure');
      };
      const payload = makeCommentPayload('/opencara review');
      const res = await sendWebhook(app, 'issue_comment', payload, env);
      expect(res.status).toBe(503);
    });

    it('returns 200 when comment is not a trigger command (intentional skip)', async () => {
      const payload = makeCommentPayload('just a regular comment');
      const res = await sendWebhook(app, 'issue_comment', payload, env);
      expect(res.status).toBe(200);
    });

    it('returns 200 when comment is not on a PR (intentional skip)', async () => {
      const payload = makeCommentPayload('/opencara review', 'OWNER', {
        issue: { number: 42 }, // no pull_request field
      });
      const res = await sendWebhook(app, 'issue_comment', payload, env);
      expect(res.status).toBe(200);
    });

    it('returns 200 when author is not trusted (intentional skip)', async () => {
      const payload = makeCommentPayload('/opencara review', 'NONE');
      const res = await sendWebhook(app, 'issue_comment', payload, env);
      expect(res.status).toBe(200);
    });

    it('returns 200 when no installation is present (intentional skip)', async () => {
      const payload = makeCommentPayload('/opencara review', 'OWNER', {
        installation: undefined,
      });
      const res = await sendWebhook(app, 'issue_comment', payload, env);
      expect(res.status).toBe(200);
    });

    it('returns 200 on successful task creation', async () => {
      const payload = makeCommentPayload('/opencara review');
      const res = await sendWebhook(app, 'issue_comment', payload, env);
      expect(res.status).toBe(200);
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
    });
  });

  // ── @mention trigger alias ──────────────────────────────────

  describe('@mention trigger alias', () => {
    it('triggers on @opencara review (same as /opencara review)', async () => {
      const payload = makeCommentPayload('@opencara review');
      const res = await sendWebhook(app, 'issue_comment', payload, env);
      expect(res.status).toBe(200);
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
    });

    it('triggers on @OPENCARA REVIEW (case-insensitive)', async () => {
      const payload = makeCommentPayload('@OPENCARA REVIEW');
      const res = await sendWebhook(app, 'issue_comment', payload, env);
      expect(res.status).toBe(200);
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
    });

    it('triggers on @opencara review with trailing text (prefix match)', async () => {
      const payload = makeCommentPayload('@opencara review please check');
      const res = await sendWebhook(app, 'issue_comment', payload, env);
      expect(res.status).toBe(200);
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
    });

    it('accepts @review when custom trigger is /review', async () => {
      github.configOverride = {
        ...DEFAULT_REVIEW_CONFIG,
        trigger: { ...DEFAULT_REVIEW_CONFIG.trigger, comment: '/review' },
      };
      const payload = makeCommentPayload('@review');
      const res = await sendWebhook(app, 'issue_comment', payload, env);
      expect(res.status).toBe(200);
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
    });

    it('does not trigger on non-matching @ comments', async () => {
      const payload = makeCommentPayload('@someone please review');
      const res = await sendWebhook(app, 'issue_comment', payload, env);
      expect(res.status).toBe(200);
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(0);
    });
  });
});
