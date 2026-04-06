/**
 * Tests covering server source gaps:
 * - review-formatter.ts: formatTimeoutComment edge cases
 * - github/config.ts: loadReviewConfig error paths
 * - github/reviews.ts: postPrComment error path
 * - index.ts: error handler and 404
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_REVIEW_CONFIG, DEFAULT_OPENCARA_CONFIG } from '@opencara/shared';
import type { GitHubService } from '../github/service.js';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── review-formatter.ts ──────────────────────────────────────

describe('review-formatter edge cases', () => {
  it('formatTimeoutComment with no reviews returns simple timeout message', async () => {
    const { formatTimeoutComment } = await import('../review-formatter.js');
    const result = formatTimeoutComment(10, []);
    expect(result).toContain('## OpenCara Review');
    expect(result).toContain('> Review timed out after 10 minutes.');
    expect(result).not.toContain('partial review');
    expect(result).toContain('<sub>Reviewed by');
  });

  it('formatTimeoutComment with reviews returns consolidated comment', async () => {
    const { formatTimeoutComment } = await import('../review-formatter.js');
    const result = formatTimeoutComment(10, [
      { model: 'claude', tool: 'cli', verdict: 'approve', review_text: 'LGTM' },
      { model: 'gemini', tool: 'codex', verdict: 'request_changes', review_text: 'Fix bugs' },
    ]);
    expect(result).toContain('## OpenCara Review');
    expect(result).toContain('timed out after 10 minutes');
    expect(result).toContain('2 partial review(s) collected');
    expect(result).toContain('Review 1');
    expect(result).toContain('`claude/cli`');
    expect(result).toContain('approve');
    expect(result).toContain('LGTM');
    expect(result).toContain('Review 2');
    expect(result).toContain('`gemini/codex`');
    expect(result).toContain('request_changes');
    expect(result).toContain('Fix bugs');
    expect(result).toContain('---');
    expect(result).toContain('<sub>Reviewed by');
  });

  it('formatTimeoutComment with single review', async () => {
    const { formatTimeoutComment } = await import('../review-formatter.js');
    const result = formatTimeoutComment(5, [
      { model: 'gpt', tool: 'tool', verdict: 'comment', review_text: 'Minor suggestions' },
    ]);
    expect(result).toContain('## OpenCara Review');
    expect(result).toContain('1 partial review(s) collected');
    expect(result).toContain('Review 1');
    expect(result).toContain('`gpt/tool`');
    expect(result).toContain('Minor suggestions');
    expect(result).toContain('<sub>Reviewed by');
  });

  it('formatTimeoutComment includes thinking level when present', async () => {
    const { formatTimeoutComment } = await import('../review-formatter.js');
    const result = formatTimeoutComment(10, [
      {
        model: 'claude',
        tool: 'cli',
        thinking: '10000',
        verdict: 'approve',
        review_text: 'LGTM with thinking',
      },
    ]);
    expect(result).toContain('`claude/cli`, thinking: 10000');
    expect(result).toContain('LGTM with thinking');
  });

  it('formatTimeoutComment omits thinking when not present', async () => {
    const { formatTimeoutComment } = await import('../review-formatter.js');
    const result = formatTimeoutComment(10, [
      { model: 'claude', tool: 'cli', verdict: 'approve', review_text: 'LGTM' },
    ]);
    expect(result).toContain('`claude/cli`)');
    expect(result).not.toContain('thinking');
  });

  it('formatTimeoutComment sanitizes thinking field (strips backticks and newlines)', async () => {
    const { formatTimeoutComment } = await import('../review-formatter.js');
    const result = formatTimeoutComment(10, [
      {
        model: 'claude',
        tool: 'cli',
        thinking: '`injected`\nheading',
        verdict: 'approve',
        review_text: 'LGTM',
      },
    ]);
    expect(result).toContain('thinking: injectedheading');
    expect(result).not.toContain('`injected`');
  });

  it('wrapReviewComment wraps text with header and footer', async () => {
    const { wrapReviewComment } = await import('../review-formatter.js');
    const result = wrapReviewComment('LGTM, no issues.');
    expect(result).toContain('## OpenCara Review');
    expect(result).toContain('LGTM, no issues.');
    expect(result).toContain('<sub>Reviewed by');
    expect(result).not.toContain('**Contributors**');
  });

  it('wrapReviewComment includes contributors in header when provided', async () => {
    const { wrapReviewComment } = await import('../review-formatter.js');
    const result = wrapReviewComment('LGTM', ['alice', 'bob']);
    expect(result).toContain('## OpenCara Review');
    expect(result).toContain('**Contributors**: @alice, @bob');
    expect(result).toContain('LGTM');
    expect(result).toContain('<sub>Reviewed by');
  });
});

// ── github/config.ts ─────────────────────────────────────────

describe('github/config.ts edge cases', () => {
  it('fetchReviewConfig returns null on 404', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
    });

    const { fetchReviewConfig } = await import('../github/config.js');
    const result = await fetchReviewConfig('owner', 'repo', 'main', 'token');
    expect(result).toBeNull();
  });

  it('fetchReviewConfig throws on non-retryable error (403)', async () => {
    // Use 403 instead of 500 because 500 is retried by githubFetch
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 403,
      ok: false,
      statusText: 'Forbidden',
    });

    const { fetchReviewConfig } = await import('../github/config.js');
    await expect(fetchReviewConfig('owner', 'repo', 'main', 'token')).rejects.toThrow(
      'Failed to fetch .opencara.toml',
    );
  });

  it('fetchPrDetails returns null on failure', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Use 403 (non-retryable) to avoid githubFetch retry delay
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 403,
      ok: false,
      statusText: 'Forbidden',
    });

    const { fetchPrDetails } = await import('../github/config.js');
    const result = await fetchPrDetails('owner', 'repo', 1, 'token');
    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch PR details'),
    );
  });

  it('loadReviewConfig returns default when fetchReviewConfig throws', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Network error is retried by githubFetch (3 retries with exponential backoff)
    globalThis.fetch = vi.fn().mockImplementation(() => {
      return Promise.reject(new Error('Network error'));
    });

    const { loadReviewConfig } = await import('../github/config.js');
    const { config, parseError } = await loadReviewConfig('owner', 'repo', 'main', 1, 'token');
    expect(config).toEqual(DEFAULT_REVIEW_CONFIG);
    expect(parseError).toBe(false);
  }, 15_000);

  it('loadReviewConfig returns default when .opencara.toml is missing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
    });

    const { loadReviewConfig } = await import('../github/config.js');
    const { config, parseError } = await loadReviewConfig('owner', 'repo', 'main', 1, 'token');
    expect(config).toEqual(DEFAULT_REVIEW_CONFIG);
    expect(parseError).toBe(false);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No .opencara.toml found'));
  });

  it('loadReviewConfig handles malformed TOML and posts comment', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let commentPosted = false;

    globalThis.fetch = vi.fn().mockImplementation((url: string, _init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url);

      // .opencara.toml fetch returns malformed TOML
      if (urlStr.includes('/contents/.opencara.toml')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          text: () => Promise.resolve('{{invalid toml [broken'),
        });
      }

      // Post comment endpoint
      if (urlStr.includes('/issues/') && urlStr.includes('/comments')) {
        commentPosted = true;
        return Promise.resolve({
          status: 201,
          ok: true,
          json: () => Promise.resolve({ html_url: 'https://example.com' }),
        });
      }

      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    });

    const { loadReviewConfig } = await import('../github/config.js');
    const { config, parseError } = await loadReviewConfig('owner', 'repo', 'main', 1, 'token');
    expect(config).toEqual(DEFAULT_REVIEW_CONFIG);
    expect(parseError).toBe(true);
    expect(commentPosted).toBe(true);
  });

  it('loadReviewConfig handles comment post failure gracefully', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});

    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = typeof url === 'string' ? url : String(url);

      if (urlStr.includes('/contents/.opencara.toml')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          text: () => Promise.resolve('{{invalid toml [broken'),
        });
      }

      // Comment post fails with non-retryable error
      if (urlStr.includes('/issues/') && urlStr.includes('/comments')) {
        return Promise.resolve({
          status: 403,
          ok: false,
          statusText: 'Forbidden',
        });
      }

      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    });

    const { loadReviewConfig } = await import('../github/config.js');
    const { config, parseError } = await loadReviewConfig('owner', 'repo', 'main', 1, 'token');
    expect(config).toEqual(DEFAULT_REVIEW_CONFIG);
    expect(parseError).toBe(true);
    // Should log error but not throw — now outputs structured JSON
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to post error comment'),
    );
  });
});

// ── github/reviews.ts ────────────────────────────────────────

describe('github/reviews.ts edge cases', () => {
  it('postPrComment throws on failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 403,
      ok: false,
      statusText: 'Forbidden',
    });

    const { postPrComment } = await import('../github/reviews.js');
    await expect(postPrComment('o', 'r', 1, 'body', 'token')).rejects.toThrow(
      'Failed to post PR comment: 403 Forbidden',
    );
  });
});

// KVDataStore tests removed — KV store was removed in #357.

// ── index.ts edge cases ──────────────────────────────────────

describe('Server app edge cases', () => {
  it('returns 404 for unknown routes', async () => {
    const { createApp } = await import('../index.js');
    const { MemoryDataStore } = await import('../store/memory.js');
    const store = new MemoryDataStore();
    const app = createApp(store);

    const res = await app.request(
      '/unknown/route',
      {},
      {
        GITHUB_WEBHOOK_SECRET: 'test',
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: 'key',
        WEB_URL: 'https://test.com',
      },
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toEqual({ error: { code: 'INVALID_REQUEST', message: 'Not Found' } });
  });
});

// ── webhook.ts edge cases ───────────────────────────────────

describe('webhook.ts edge cases', () => {
  const WEBHOOK_SECRET = 'test-webhook-secret';
  let TEST_PEM: string;

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

  async function setupApp(githubService?: GitHubService) {
    const { generateKeyPairSync } = await import('node:crypto');
    if (!TEST_PEM) {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      TEST_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    }
    const { createApp } = await import('../index.js');
    const { MemoryDataStore } = await import('../store/memory.js');
    const store = new MemoryDataStore();
    const app = createApp(store, githubService);
    const mockEnv = {
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY: TEST_PEM,
      WEB_URL: 'https://test.com',
    };
    return { app, store, mockEnv };
  }

  async function sendWebhook(
    app: ReturnType<Awaited<ReturnType<typeof setupApp>>['app']>,
    mockEnv: Record<string, unknown>,
    event: string,
    payload: Record<string, unknown>,
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
      mockEnv,
    );
  }

  it('returns 400 for malformed JSON body', async () => {
    const { app, mockEnv } = await setupApp();
    const body = 'not valid json{{{';
    const signature = await signPayload(body, WEBHOOK_SECRET);
    const res = await app.request(
      '/webhook/github',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Hub-Signature-256': signature,
          'X-GitHub-Event': 'pull_request',
        },
        body,
      },
      mockEnv,
    );
    expect(res.status).toBe(400);
  });

  it('handles installation event', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, mockEnv } = await setupApp();
    const res = await sendWebhook(app, mockEnv, 'installation', {
      action: 'created',
    });
    expect(res.status).toBe(200);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"Installation event"'));
  });

  it('handles unknown event type', async () => {
    const { app, mockEnv } = await setupApp();
    const res = await sendWebhook(app, mockEnv, 'push', { action: 'completed' });
    expect(res.status).toBe(200);
  });

  it('handles issue_comment with non-created action', async () => {
    const { app, mockEnv } = await setupApp();
    const res = await sendWebhook(app, mockEnv, 'issue_comment', {
      action: 'deleted',
      repository: { owner: { login: 'o' }, name: 'r' },
      issue: { number: 1, pull_request: { url: 'https://example.com' } },
      comment: { body: '/opencara review', user: { login: 'u' }, author_association: 'OWNER' },
    });
    expect(res.status).toBe(200);
  });

  it('PR event without installation is skipped', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, mockEnv } = await setupApp();
    const res = await sendWebhook(app, mockEnv, 'pull_request', {
      action: 'opened',
      // no installation field
      repository: { owner: { login: 'o' }, name: 'r' },
      pull_request: {
        number: 1,
        html_url: 'https://github.com/o/r/pull/1',
        diff_url: 'https://github.com/o/r/pull/1.diff',
        base: { ref: 'main' },
        head: { ref: 'feat', sha: 'abc123' },
      },
    });
    expect(res.status).toBe(200);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('PR event without installation'),
    );
  });

  it('PR event with failed installation token returns 503', async () => {
    // Inject a GitHubService that throws on getInstallationToken
    const failingGithub: GitHubService = {
      async getInstallationToken() {
        throw new Error('Forbidden');
      },
      async postPrComment() {
        return { html_url: '', comment_id: 0 };
      },
      async getCommentReactions() {
        return [];
      },
      async fetchPrDetails() {
        return null;
      },
      async loadReviewConfig() {
        return { config: DEFAULT_REVIEW_CONFIG, parseError: false };
      },
      async updateIssue() {},
      async fetchIssueBody() {
        return null;
      },
      async createIssue() {
        return 0;
      },
    };
    const { app, mockEnv } = await setupApp(failingGithub);
    const res = await sendWebhook(app, mockEnv, 'pull_request', {
      action: 'opened',
      installation: { id: 999 },
      repository: { owner: { login: 'o' }, name: 'r' },
      pull_request: {
        number: 1,
        html_url: 'https://github.com/o/r/pull/1',
        diff_url: 'https://github.com/o/r/pull/1.diff',
        base: { ref: 'main' },
        head: { ref: 'feat', sha: 'abc123' },
      },
    });
    expect(res.status).toBe(503);
  });

  it('PR event with .opencara.toml parse error returns 503', async () => {
    // Inject a GitHubService that returns parseError: true from loadOpenCaraConfig
    const parseErrorGithub: GitHubService = {
      async getInstallationToken() {
        return 'ghs_test';
      },
      async postPrComment() {
        return { html_url: '', comment_id: 0 };
      },
      async getCommentReactions() {
        return [];
      },
      async fetchPrDetails() {
        return null;
      },
      async loadReviewConfig() {
        return { config: DEFAULT_REVIEW_CONFIG, parseError: true };
      },
      async loadOpenCaraConfig() {
        return { config: DEFAULT_OPENCARA_CONFIG, parseError: true };
      },
      async updateIssue() {},
      async fetchIssueBody() {
        return null;
      },
      async createIssue() {
        return 0;
      },
    };
    const { app, mockEnv } = await setupApp(parseErrorGithub);
    const res = await sendWebhook(app, mockEnv, 'pull_request', {
      action: 'opened',
      installation: { id: 999 },
      repository: { owner: { login: 'o' }, name: 'r' },
      pull_request: {
        number: 1,
        html_url: 'https://github.com/o/r/pull/1',
        diff_url: 'https://github.com/o/r/pull/1.diff',
        base: { ref: 'main' },
        head: { ref: 'feat', sha: 'abc123' },
      },
    });
    expect(res.status).toBe(503);
  });

  it('issue_comment with .opencara.toml parse error returns 503', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Inject a GitHubService that returns parseError: true from loadReviewConfig
    const parseErrorGithub: GitHubService = {
      async getInstallationToken() {
        return 'ghs_test';
      },
      async postPrComment() {
        return { html_url: '', comment_id: 0 };
      },
      async getCommentReactions() {
        return [];
      },
      async fetchPrDetails() {
        return {
          number: 1,
          html_url: 'https://github.com/o/r/pull/1',
          diff_url: 'https://github.com/o/r/pull/1.diff',
          base: { ref: 'main' },
          head: { ref: 'feat', sha: 'abc123' },
          user: { login: 'pr-author' },
          draft: false,
          labels: [],
        };
      },
      async loadReviewConfig() {
        return { config: DEFAULT_REVIEW_CONFIG, parseError: true };
      },
      async loadOpenCaraConfig() {
        return { config: DEFAULT_OPENCARA_CONFIG, parseError: true };
      },
      async updateIssue() {},
      async fetchIssueBody() {
        return null;
      },
      async createIssue() {
        return 0;
      },
    };
    const { app, store, mockEnv } = await setupApp(parseErrorGithub);
    const res = await sendWebhook(app, mockEnv, 'issue_comment', {
      action: 'created',
      installation: { id: 999 },
      repository: { owner: { login: 'o' }, name: 'r' },
      issue: { number: 1, pull_request: { url: 'https://example.com' } },
      comment: { body: '/opencara review', user: { login: 'u' }, author_association: 'OWNER' },
    });
    expect(res.status).toBe(503);
    // Verify no task was created
    const tasks = await store.listTasks({ status: 'pending' });
    expect(tasks).toHaveLength(0);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Aborting comment trigger due to .opencara.toml parse error'),
    );
  });

  it('issue_comment on non-PR issue is skipped', async () => {
    const { app, mockEnv } = await setupApp();
    const res = await sendWebhook(app, mockEnv, 'issue_comment', {
      action: 'created',
      installation: { id: 999 },
      repository: { owner: { login: 'o' }, name: 'r' },
      issue: { number: 1 }, // no pull_request field
      comment: { body: '/opencara review', user: { login: 'u' }, author_association: 'OWNER' },
    });
    expect(res.status).toBe(200);
  });

  it('issue_comment without installation is skipped', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { app, mockEnv } = await setupApp();
    const res = await sendWebhook(app, mockEnv, 'issue_comment', {
      action: 'created',
      // no installation
      repository: { owner: { login: 'o' }, name: 'r' },
      issue: { number: 1, pull_request: { url: 'https://example.com' } },
      comment: { body: '/opencara review', user: { login: 'u' }, author_association: 'OWNER' },
    });
    expect(res.status).toBe(200);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Comment event without installation'),
    );
  });

  it('issue_comment with failed installation token returns 503', async () => {
    // Inject a GitHubService that throws on getInstallationToken
    const failingGithub: GitHubService = {
      async getInstallationToken() {
        throw new Error('Forbidden');
      },
      async postPrComment() {
        return { html_url: '', comment_id: 0 };
      },
      async getCommentReactions() {
        return [];
      },
      async fetchPrDetails() {
        return null;
      },
      async loadReviewConfig() {
        return { config: DEFAULT_REVIEW_CONFIG, parseError: false };
      },
      async updateIssue() {},
      async fetchIssueBody() {
        return null;
      },
      async createIssue() {
        return 0;
      },
    };
    const { app, mockEnv } = await setupApp(failingGithub);
    const res = await sendWebhook(app, mockEnv, 'issue_comment', {
      action: 'created',
      installation: { id: 999 },
      repository: { owner: { login: 'o' }, name: 'r' },
      issue: { number: 1, pull_request: { url: 'https://example.com' } },
      comment: { body: '/opencara review', user: { login: 'u' }, author_association: 'OWNER' },
    });
    expect(res.status).toBe(503);
  });

  it('issue_comment with failed PR details fetch returns 503', async () => {
    // Inject a GitHubService where fetchPrDetails returns null
    const failingGithub: GitHubService = {
      async getInstallationToken() {
        return 'ghs_test';
      },
      async postPrComment() {
        return { html_url: '', comment_id: 0 };
      },
      async getCommentReactions() {
        return [];
      },
      async fetchPrDetails() {
        return null;
      },
      async loadReviewConfig() {
        return { config: DEFAULT_REVIEW_CONFIG, parseError: false };
      },
      async updateIssue() {},
      async fetchIssueBody() {
        return null;
      },
      async createIssue() {
        return 0;
      },
    };
    const { app, mockEnv } = await setupApp(failingGithub);
    const res = await sendWebhook(app, mockEnv, 'issue_comment', {
      action: 'created',
      installation: { id: 999 },
      repository: { owner: { login: 'o' }, name: 'r' },
      issue: { number: 1, pull_request: { url: 'https://example.com' } },
      comment: { body: '/opencara review', user: { login: 'u' }, author_association: 'OWNER' },
    });
    expect(res.status).toBe(503);
  });

  it('issue_comment with non-matching trigger command is skipped', async () => {
    const { app, mockEnv } = await setupApp();
    const res = await sendWebhook(app, mockEnv, 'issue_comment', {
      action: 'created',
      installation: { id: 999 },
      repository: { owner: { login: 'o' }, name: 'r' },
      issue: { number: 1, pull_request: { url: 'https://example.com' } },
      comment: {
        body: 'just a regular comment, not a trigger',
        user: { login: 'u' },
        author_association: 'OWNER',
      },
    });
    expect(res.status).toBe(200);
  });

  it('issue_comment from untrusted author is skipped', async () => {
    const { app, mockEnv } = await setupApp();
    const res = await sendWebhook(app, mockEnv, 'issue_comment', {
      action: 'created',
      installation: { id: 999 },
      repository: { owner: { login: 'o' }, name: 'r' },
      issue: { number: 1, pull_request: { url: 'https://example.com' } },
      comment: {
        body: '/opencara review',
        user: { login: 'random-user' },
        author_association: 'NONE',
      },
    });
    expect(res.status).toBe(200);
  });
});
