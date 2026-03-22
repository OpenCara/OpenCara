/**
 * Tests covering server source gaps:
 * - review-formatter.ts: formatSummaryComment edge cases (lines 17-19, 41)
 * - github/config.ts: loadReviewConfig error paths (lines 51, 57-61, 81-83, 90-108)
 * - github/reviews.ts: postPrComment error path (lines 31-32)
 * - store/kv.ts: setAgentLastSeen and getAgentLastSeen (lines 183-190),
 *   updateTask returns false for non-existent (lines 105-106)
 * - index.ts: error handler and 404 (lines 49-50, 66)
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ── review-formatter.ts ──────────────────────────────────────

describe('review-formatter edge cases', () => {
  it('formatSummaryComment with no agents and no synthesizer', async () => {
    const { formatSummaryComment } = await import('../review-formatter.js');
    const result = formatSummaryComment('My summary text', [], null);
    expect(result).toContain('My summary text');
    expect(result).toContain('OpenCara Review');
    // No agents line when both are empty
    expect(result).not.toContain('**Agents**');
  });

  it('formatSummaryComment with agents and synthesizer', async () => {
    const { formatSummaryComment } = await import('../review-formatter.js');
    const result = formatSummaryComment(
      'Summary',
      [
        { model: 'claude', tool: 'claude-cli' },
        { model: 'gpt-4', tool: 'codex', displayName: 'My Agent' },
      ],
      { model: 'claude', tool: 'claude-cli', displayName: 'Synth' },
    );
    expect(result).toContain('`claude/claude-cli`');
    expect(result).toContain('My Agent');
    expect(result).toContain('synthesized by');
    expect(result).toContain('Synth');
  });

  it('formatSummaryComment with synthesizer only (no review agents)', async () => {
    const { formatSummaryComment } = await import('../review-formatter.js');
    const result = formatSummaryComment('Summary', [], {
      model: 'claude',
      tool: 'claude-cli',
    });
    expect(result).toContain('**Agents**: `claude/claude-cli`');
  });

  it('formatIndividualReviewComment formats review with emoji', async () => {
    const { formatIndividualReviewComment } = await import('../review-formatter.js');

    const approve = formatIndividualReviewComment('claude', 'cli', 'approve', 'LGTM');
    expect(approve).toContain('Agent: `claude` / `cli`');
    expect(approve).toContain('approve');
    expect(approve).toContain('LGTM');

    const changes = formatIndividualReviewComment('gpt', 'codex', 'request_changes', 'Fix bugs');
    expect(changes).toContain('request_changes');

    const comment = formatIndividualReviewComment('gemini', 'tool', 'comment', 'Looks ok');
    expect(comment).toContain('comment');
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
      'Failed to fetch .review.yml',
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

  it('loadReviewConfig returns default when .review.yml is missing', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 404,
      ok: false,
    });

    const { loadReviewConfig } = await import('../github/config.js');
    const { config, parseError } = await loadReviewConfig('owner', 'repo', 'main', 1, 'token');
    expect(config).toEqual(DEFAULT_REVIEW_CONFIG);
    expect(parseError).toBe(false);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('No .review.yml found'));
  });

  it('loadReviewConfig handles malformed YAML and posts comment', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    let commentPosted = false;

    globalThis.fetch = vi.fn().mockImplementation((url: string, _init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url);

      // .review.yml fetch returns malformed YAML
      if (urlStr.includes('/contents/.review.yml')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          text: () => Promise.resolve('invalid: yaml: [broken'),
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

      if (urlStr.includes('/contents/.review.yml')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          text: () => Promise.resolve('invalid: yaml: [broken'),
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
    // Should log error but not throw
    expect(console.error).toHaveBeenCalledWith('Failed to post error comment:', expect.any(Error));
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

// ── store/kv.ts agent last-seen ──────────────────────────────

describe('KVTaskStore agent last-seen', () => {
  class MockKV {
    private data = new Map<string, { value: string; metadata?: unknown }>();
    putCalls: Array<{ key: string; value: string; options?: unknown }> = [];

    async get(key: string): Promise<string | null> {
      const entry = this.data.get(key);
      return entry?.value ?? null;
    }
    async put(key: string, value: string, options?: unknown): Promise<void> {
      this.putCalls.push({ key, value, options });
      this.data.set(key, { value, metadata: (options as { metadata?: unknown })?.metadata });
    }
    async delete(key: string): Promise<void> {
      this.data.delete(key);
    }
    async list(opts: {
      prefix: string;
    }): Promise<{ keys: Array<{ name: string; metadata?: unknown }> }> {
      const keys: Array<{ name: string; metadata?: unknown }> = [];
      for (const [k, entry] of this.data.entries()) {
        if (k.startsWith(opts.prefix)) {
          keys.push({ name: k, metadata: entry.metadata });
        }
      }
      return { keys };
    }
  }

  it('setAgentLastSeen stores timestamp and getAgentLastSeen retrieves it', async () => {
    const { KVTaskStore } = await import('../store/kv.js');
    const kv = new MockKV();
    const store = new KVTaskStore(kv as unknown as KVNamespace);

    await store.setAgentLastSeen('agent-1', 1234567890);
    const result = await store.getAgentLastSeen('agent-1');
    expect(result).toBe(1234567890);
  });

  it('getAgentLastSeen returns null for unknown agent', async () => {
    const { KVTaskStore } = await import('../store/kv.js');
    const kv = new MockKV();
    const store = new KVTaskStore(kv as unknown as KVNamespace);

    const result = await store.getAgentLastSeen('unknown-agent');
    expect(result).toBeNull();
  });

  it('updateTask returns false for non-existent task', async () => {
    const { KVTaskStore } = await import('../store/kv.js');
    const kv = new MockKV();
    const store = new KVTaskStore(kv as unknown as KVNamespace);

    const result = await store.updateTask('nonexistent', { status: 'completed' });
    expect(result).toBe(false);
  });

  it('updateClaim does nothing for non-existent claim', async () => {
    const { KVTaskStore } = await import('../store/kv.js');
    const kv = new MockKV();
    const store = new KVTaskStore(kv as unknown as KVNamespace);

    await store.updateClaim('nonexistent:agent', { status: 'completed' });
    expect(kv.putCalls).toHaveLength(0);
  });
});

// ── index.ts edge cases ──────────────────────────────────────

describe('Server app edge cases', () => {
  it('returns 404 for unknown routes', async () => {
    const { createApp } = await import('../index.js');
    const { MemoryTaskStore } = await import('../store/memory.js');
    const store = new MemoryTaskStore();
    const app = createApp(store);

    const res = await app.request(
      '/unknown/route',
      {},
      {
        GITHUB_WEBHOOK_SECRET: 'test',
        GITHUB_APP_ID: '1',
        GITHUB_APP_PRIVATE_KEY: 'key',
        TASK_STORE: {} as KVNamespace,
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

  async function setupApp() {
    const { generateKeyPairSync } = await import('node:crypto');
    if (!TEST_PEM) {
      const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
      TEST_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    }
    const { createApp } = await import('../index.js');
    const { MemoryTaskStore } = await import('../store/memory.js');
    const store = new MemoryTaskStore();
    const app = createApp(store);
    const mockEnv = {
      GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY: TEST_PEM,
      TASK_STORE: {} as KVNamespace,
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
    expect(console.log).toHaveBeenCalledWith('Installation event: created');
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
        head: { ref: 'feat' },
      },
    });
    expect(res.status).toBe(200);
    expect(console.log).toHaveBeenCalledWith('PR event without installation — skipping');
  });

  it('PR event with failed installation token is skipped', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // Mock fetch to make getInstallationToken fail
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 403,
      ok: false,
      statusText: 'Forbidden',
      json: () => Promise.resolve({ message: 'Forbidden' }),
    });
    const { app, mockEnv } = await setupApp();
    const res = await sendWebhook(app, mockEnv, 'pull_request', {
      action: 'opened',
      installation: { id: 999 },
      repository: { owner: { login: 'o' }, name: 'r' },
      pull_request: {
        number: 1,
        html_url: 'https://github.com/o/r/pull/1',
        diff_url: 'https://github.com/o/r/pull/1.diff',
        base: { ref: 'main' },
        head: { ref: 'feat' },
      },
    });
    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith(
      'Failed to get installation token:',
      expect.anything(),
    );
  });

  it('PR event with .review.yml parse error aborts', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    // Mock fetch: installation token succeeds, .review.yml returns malformed YAML
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = typeof url === 'string' ? url : String(url);
      if (urlStr.includes('/access_tokens')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve({ token: 'ghs_test' }),
        });
      }
      if (urlStr.includes('/contents/.review.yml')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          text: () => Promise.resolve('invalid: yaml: [broken'),
        });
      }
      // Comment post succeeds
      if (urlStr.includes('/issues/') && urlStr.includes('/comments')) {
        return Promise.resolve({
          status: 201,
          ok: true,
          json: () => Promise.resolve({ html_url: 'https://example.com' }),
        });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    });

    const { app, mockEnv } = await setupApp();
    const res = await sendWebhook(app, mockEnv, 'pull_request', {
      action: 'opened',
      installation: { id: 999 },
      repository: { owner: { login: 'o' }, name: 'r' },
      pull_request: {
        number: 1,
        html_url: 'https://github.com/o/r/pull/1',
        diff_url: 'https://github.com/o/r/pull/1.diff',
        base: { ref: 'main' },
        head: { ref: 'feat' },
      },
    });
    expect(res.status).toBe(200);
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('aborting due to .review.yml parse error'),
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
    expect(console.log).toHaveBeenCalledWith('Comment event without installation — skipping');
  });

  it('issue_comment with failed installation token is skipped', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      status: 403,
      ok: false,
      statusText: 'Forbidden',
      json: () => Promise.resolve({ message: 'Forbidden' }),
    });
    const { app, mockEnv } = await setupApp();
    const res = await sendWebhook(app, mockEnv, 'issue_comment', {
      action: 'created',
      installation: { id: 999 },
      repository: { owner: { login: 'o' }, name: 'r' },
      issue: { number: 1, pull_request: { url: 'https://example.com' } },
      comment: { body: '/opencara review', user: { login: 'u' }, author_association: 'OWNER' },
    });
    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith(
      'Failed to get installation token:',
      expect.anything(),
    );
  });

  it('issue_comment with failed PR details fetch is skipped', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = typeof url === 'string' ? url : String(url);
      if (urlStr.includes('/access_tokens')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve({ token: 'ghs_test' }),
        });
      }
      // PR details fetch fails with non-retryable error
      if (urlStr.includes('/pulls/')) {
        return Promise.resolve({
          status: 403,
          ok: false,
          statusText: 'Forbidden',
        });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    });
    const { app, mockEnv } = await setupApp();
    const res = await sendWebhook(app, mockEnv, 'issue_comment', {
      action: 'created',
      installation: { id: 999 },
      repository: { owner: { login: 'o' }, name: 'r' },
      issue: { number: 1, pull_request: { url: 'https://example.com' } },
      comment: { body: '/opencara review', user: { login: 'u' }, author_association: 'OWNER' },
    });
    expect(res.status).toBe(200);
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to fetch PR #1 details'),
    );
  });

  it('issue_comment with non-matching trigger command is skipped', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = typeof url === 'string' ? url : String(url);
      if (urlStr.includes('/access_tokens')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve({ token: 'ghs_test' }),
        });
      }
      // .review.yml not found → defaults
      if (urlStr.includes('/contents/.review.yml')) {
        return Promise.resolve({ status: 404, ok: false });
      }
      // PR details
      if (urlStr.includes('/pulls/')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () =>
            Promise.resolve({
              number: 1,
              html_url: 'https://github.com/o/r/pull/1',
              diff_url: 'https://github.com/o/r/pull/1.diff',
              base: { ref: 'main' },
              head: { ref: 'feat' },
            }),
        });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    });
    vi.spyOn(console, 'log').mockImplementation(() => {});
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
    vi.spyOn(console, 'log').mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      const urlStr = typeof url === 'string' ? url : String(url);
      if (urlStr.includes('/access_tokens')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () => Promise.resolve({ token: 'ghs_test' }),
        });
      }
      if (urlStr.includes('/contents/.review.yml')) {
        return Promise.resolve({ status: 404, ok: false });
      }
      if (urlStr.includes('/pulls/')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          json: () =>
            Promise.resolve({
              number: 1,
              html_url: 'https://github.com/o/r/pull/1',
              diff_url: 'https://github.com/o/r/pull/1.diff',
              base: { ref: 'main' },
              head: { ref: 'feat' },
            }),
        });
      }
      return Promise.resolve({ status: 200, ok: true, json: () => Promise.resolve({}) });
    });
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
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('not a trusted contributor'));
  });
});
