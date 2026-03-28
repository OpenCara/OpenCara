import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_REVIEW_CONFIG, type ReviewTask } from '@opencara/shared';
import { MemoryDataStore } from '../store/memory.js';
import { buildApp } from '../index.js';
import type { Env } from '../types.js';
import type { HonoApp } from '../index.js';
import { NoOpGitHubService } from '../github/service.js';
import { hashToken, verifyGitHubToken } from '../middleware/oauth.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import { resetTimeoutThrottle } from '../routes/tasks.js';

// ── Helpers ─────────────────────────────────────────────────────

function makeTask(overrides: Partial<ReviewTask> = {}): ReviewTask {
  return {
    id: 'task-1',
    owner: 'test-org',
    repo: 'test-repo',
    pr_number: 1,
    pr_url: 'https://github.com/test-org/test-repo/pull/1',
    diff_url: 'https://github.com/test-org/test-repo/pull/1.diff',
    base_ref: 'main',
    head_ref: 'feature',
    review_count: 1,
    prompt: 'Review this PR',
    timeout_at: Date.now() + 600_000,
    status: 'pending',
    queue: 'summary',
    github_installation_id: 123,
    private: false,
    config: DEFAULT_REVIEW_CONFIG,
    created_at: Date.now(),
    task_type: 'summary',
    feature: 'review',
    group_id: 'group-1',
    ...overrides,
  };
}

const baseEnv: Env = {
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: 'test-key',
  WEB_URL: 'https://test.com',
};

// ── hashToken ───────────────────────────────────────────────────

describe('hashToken', () => {
  it('returns a 64-char hex string', async () => {
    const hash = await hashToken('ghu_test123');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('produces consistent output for same input', async () => {
    const h1 = await hashToken('ghu_abc');
    const h2 = await hashToken('ghu_abc');
    expect(h1).toBe(h2);
  });

  it('produces different output for different inputs', async () => {
    const h1 = await hashToken('ghu_abc');
    const h2 = await hashToken('ghu_def');
    expect(h1).not.toBe(h2);
  });
});

// ── verifyGitHubToken ───────────────────────────────────────────

describe('verifyGitHubToken', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns identity for a valid token', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        json: () =>
          Promise.resolve({
            user: { id: 42, login: 'octocat' },
          }),
      }),
    );

    const result = await verifyGitHubToken('ghu_valid', 'client-id', 'client-secret');
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.identity.github_user_id).toBe(42);
      expect(result.identity.github_username).toBe('octocat');
      expect(result.identity.verified_at).toBeGreaterThan(0);
    }
  });

  it('returns revoked for 404 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 }));

    const result = await verifyGitHubToken('ghu_revoked', 'client-id', 'client-secret');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('revoked');
    }
  });

  it('returns expired for 422 response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 422 }));

    const result = await verifyGitHubToken('ghu_expired', 'client-id', 'client-secret');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('expired');
    }
  });

  it('returns revoked when user is missing from 200 response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        json: () => Promise.resolve({}),
      }),
    );

    const result = await verifyGitHubToken('ghu_nouser', 'client-id', 'client-secret');
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toBe('revoked');
    }
  });

  it('throws on unexpected status code', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 500,
        text: () => Promise.resolve('Internal Server Error'),
      }),
    );

    await expect(verifyGitHubToken('ghu_error', 'client-id', 'client-secret')).rejects.toThrow(
      'GitHub token verification failed with status 500',
    );
  });

  it('sends correct authorization and body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ user: { id: 1, login: 'test' } }),
    });
    vi.stubGlobal('fetch', mockFetch);

    await verifyGitHubToken('ghu_token', 'my-client-id', 'my-secret');

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.github.com/applications/my-client-id/token');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe(`Basic ${btoa('my-client-id:my-secret')}`);
    expect(JSON.parse(opts.body)).toEqual({ access_token: 'ghu_token' });
  });
});

// ── MemoryDataStore OAuth cache ──────────────────────────────────

describe('MemoryDataStore OAuth cache', () => {
  let store: MemoryDataStore;

  beforeEach(() => {
    store = new MemoryDataStore();
  });

  it('returns null for missing cache entry', async () => {
    const result = await store.getOAuthCache('nonexistent');
    expect(result).toBeNull();
  });

  it('stores and retrieves a cached identity', async () => {
    const identity = { github_user_id: 42, github_username: 'octocat', verified_at: Date.now() };
    await store.setOAuthCache('hash123', identity, 60_000);
    const cached = await store.getOAuthCache('hash123');
    expect(cached).toEqual(identity);
  });

  it('returns null for expired entries', async () => {
    const identity = { github_user_id: 42, github_username: 'octocat', verified_at: Date.now() };
    await store.setOAuthCache('hash123', identity, 1); // 1ms TTL
    // Wait a bit for expiry
    await new Promise((resolve) => setTimeout(resolve, 10));
    const cached = await store.getOAuthCache('hash123');
    expect(cached).toBeNull();
  });

  it('overwrites existing cache entry', async () => {
    const id1 = { github_user_id: 1, github_username: 'user1', verified_at: 100 };
    const id2 = { github_user_id: 2, github_username: 'user2', verified_at: 200 };
    await store.setOAuthCache('hash', id1, 60_000);
    await store.setOAuthCache('hash', id2, 60_000);
    const cached = await store.getOAuthCache('hash');
    expect(cached?.github_user_id).toBe(2);
  });

  it('cleanupExpiredOAuthCache removes expired entries', async () => {
    const identity = { github_user_id: 42, github_username: 'octocat', verified_at: Date.now() };
    await store.setOAuthCache('expired', identity, 1);
    await store.setOAuthCache('valid', identity, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const removed = await store.cleanupExpiredOAuthCache();
    expect(removed).toBe(1);
    expect(await store.getOAuthCache('expired')).toBeNull();
    expect(await store.getOAuthCache('valid')).not.toBeNull();
  });

  it('reset clears OAuth cache', async () => {
    const identity = { github_user_id: 42, github_username: 'octocat', verified_at: Date.now() };
    await store.setOAuthCache('hash', identity, 60_000);
    store.reset();
    expect(await store.getOAuthCache('hash')).toBeNull();
  });
});

// ── OAuth middleware integration ─────────────────────────────────

describe('OAuth middleware integration', () => {
  let store: MemoryDataStore;
  let app: HonoApp;

  function createOAuthApp(envOverrides: Partial<Env> = {}) {
    store = new MemoryDataStore();
    const svc = new NoOpGitHubService();
    app = buildApp(
      () => store,
      () => svc,
    );
    return { ...baseEnv, ...envOverrides };
  }

  beforeEach(() => {
    resetTimeoutThrottle();
    resetRateLimits();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function request(
    method: string,
    path: string,
    body: unknown,
    env: Env,
    headers?: Record<string, string>,
  ) {
    return app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json', ...headers },
        body: body ? JSON.stringify(body) : undefined,
      },
      env,
    );
  }

  describe('when OAuth credentials are configured', () => {
    it('returns AUTH_REQUIRED when no Authorization header', async () => {
      const env = createOAuthApp({
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'csecret',
      });
      await store.createTask(makeTask());

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe('AUTH_REQUIRED');
    });

    it('returns AUTH_REQUIRED for non-Bearer header', async () => {
      const env = createOAuthApp({
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'csecret',
      });

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env, {
        Authorization: 'Basic abc123',
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe('AUTH_REQUIRED');
    });

    it('returns AUTH_TOKEN_REVOKED for invalid token', async () => {
      const env = createOAuthApp({
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'csecret',
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 404 }));

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env, {
        Authorization: 'Bearer ghu_invalid',
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe('AUTH_TOKEN_REVOKED');
    });

    it('returns AUTH_TOKEN_EXPIRED for expired token', async () => {
      const env = createOAuthApp({
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'csecret',
      });
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ status: 422 }));

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env, {
        Authorization: 'Bearer ghu_expired',
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe('AUTH_TOKEN_EXPIRED');
    });

    it('allows valid OAuth token and passes request through', async () => {
      const env = createOAuthApp({
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'csecret',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          status: 200,
          json: () => Promise.resolve({ user: { id: 42, login: 'octocat' } }),
        }),
      );
      await store.createTask(makeTask());

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env, {
        Authorization: 'Bearer ghu_valid_token',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tasks).toBeDefined();
    });

    it('uses cache on second request (does not call GitHub API again)', async () => {
      const env = createOAuthApp({
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'csecret',
      });
      const mockFetch = vi.fn().mockResolvedValue({
        status: 200,
        json: () => Promise.resolve({ user: { id: 42, login: 'octocat' } }),
      });
      vi.stubGlobal('fetch', mockFetch);

      // First request — hits GitHub API and caches
      const res1 = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env, {
        Authorization: 'Bearer ghu_cacheable',
      });
      expect(res1.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1);

      // Second request — should use cache
      const res2 = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env, {
        Authorization: 'Bearer ghu_cacheable',
      });
      expect(res2.status).toBe(200);
      expect(mockFetch).toHaveBeenCalledTimes(1); // Still 1, not 2
    });

    it('returns 500 when GitHub API returns unexpected error', async () => {
      const env = createOAuthApp({
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'csecret',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          status: 500,
          text: () => Promise.resolve('Server Error'),
        }),
      );

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env, {
        Authorization: 'Bearer ghu_error',
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });

    it('falls back to API key auth when GITHUB_CLIENT_ID is not configured', async () => {
      const env = createOAuthApp({
        // No GITHUB_CLIENT_ID or GITHUB_CLIENT_SECRET — falls back to API key
      });

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env, {
        Authorization: 'Bearer ghu_token',
      });
      // Open mode (no API_KEYS set) — should allow through
      expect(res.status).toBe(200);
    });

    it('returns 500 on network error during verification', async () => {
      const env = createOAuthApp({
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'csecret',
      });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network failure')));

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env, {
        Authorization: 'Bearer ghu_network_error',
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });

    it('returns structured INTERNAL_ERROR when cache read fails', async () => {
      const env = createOAuthApp({
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'csecret',
      });

      // Make getOAuthCache throw to simulate D1 read failure
      vi.spyOn(store, 'getOAuthCache').mockRejectedValueOnce(new Error('D1 read failed'));

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env, {
        Authorization: 'Bearer ghu_cache_read_fail',
      });
      expect(res.status).toBe(500);
      const body = await res.json();
      // Should return structured error, not unstructured 500
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });

    it('succeeds even when cache write fails (best-effort caching)', async () => {
      const env = createOAuthApp({
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'csecret',
      });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          status: 200,
          json: () => Promise.resolve({ user: { id: 42, login: 'octocat' } }),
        }),
      );

      // Make setOAuthCache throw to simulate D1 write failure
      const origSet = store.setOAuthCache.bind(store);
      vi.spyOn(store, 'setOAuthCache').mockRejectedValueOnce(new Error('D1 write failed'));

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env, {
        Authorization: 'Bearer ghu_cache_fail',
      });
      // Request should still succeed despite cache write failure
      expect(res.status).toBe(200);

      // Restore for cleanup
      vi.mocked(store.setOAuthCache).mockImplementation(origSet);
    });
  });

  describe('fallback to API key auth (no OAuth credentials)', () => {
    it('uses API key auth when OAuth credentials are not configured', async () => {
      const env = createOAuthApp({ API_KEYS: 'valid-key' });

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env, {
        Authorization: 'Bearer valid-key',
      });
      expect(res.status).toBe(200);
    });

    it('rejects invalid API key when OAuth credentials are not configured', async () => {
      const env = createOAuthApp({ API_KEYS: 'valid-key' });

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env, {
        Authorization: 'Bearer wrong-key',
      });
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe('UNAUTHORIZED');
    });

    it('allows open mode when no API_KEYS and no OAuth credentials', async () => {
      const env = createOAuthApp();

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env);
      expect(res.status).toBe(200);
    });
  });

  describe('OAuth on mutation endpoints', () => {
    it('enforces OAuth on claim endpoint', async () => {
      const env = createOAuthApp({
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'csecret',
      });

      const res = await request(
        'POST',
        '/api/tasks/task-1/claim',
        { agent_id: 'agent-1', role: 'review' },
        env,
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe('AUTH_REQUIRED');
    });

    it('enforces OAuth on result endpoint', async () => {
      const env = createOAuthApp({
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'csecret',
      });

      const res = await request(
        'POST',
        '/api/tasks/task-1/result',
        { agent_id: 'agent-1', type: 'review', review_text: 'lgtm' },
        env,
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe('AUTH_REQUIRED');
    });

    it('enforces OAuth on reject endpoint', async () => {
      const env = createOAuthApp({
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'csecret',
      });

      const res = await request(
        'POST',
        '/api/tasks/task-1/reject',
        { agent_id: 'agent-1', reason: 'skip' },
        env,
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe('AUTH_REQUIRED');
    });

    it('enforces OAuth on error endpoint', async () => {
      const env = createOAuthApp({
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'csecret',
      });

      const res = await request(
        'POST',
        '/api/tasks/task-1/error',
        { agent_id: 'agent-1', error: 'something broke' },
        env,
      );
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error.code).toBe('AUTH_REQUIRED');
    });
  });

  describe('verified identity in task routes', () => {
    function setupOAuthEnv() {
      return createOAuthApp({
        GITHUB_CLIENT_ID: 'cid',
        GITHUB_CLIENT_SECRET: 'csecret',
      });
    }

    function stubGitHubAuth(userId: number, username: string) {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          status: 200,
          json: () => Promise.resolve({ user: { id: userId, login: username } }),
        }),
      );
    }

    function oauthRequest(method: string, path: string, body: unknown, env: Env) {
      return request(method, path, body, env, {
        Authorization: 'Bearer ghu_valid_token',
      });
    }

    it('poll uses verified github_username for eligibility (whitelist match)', async () => {
      const env = setupOAuthEnv();
      stubGitHubAuth(42, 'octocat');

      // Task with a github-username whitelist
      await store.createTask(
        makeTask({
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            summarizer: {
              ...DEFAULT_REVIEW_CONFIG.summarizer,
              whitelist: [{ github: 'octocat' }],
            },
          },
        }),
      );

      const res = await oauthRequest('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env);
      expect(res.status).toBe(200);
      const body = await res.json();
      // Agent matches via verified github_username
      expect(body.tasks).toHaveLength(1);
    });

    it('poll filters out tasks when verified username not in whitelist', async () => {
      const env = setupOAuthEnv();
      stubGitHubAuth(42, 'octocat');

      await store.createTask(
        makeTask({
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            summarizer: {
              ...DEFAULT_REVIEW_CONFIG.summarizer,
              whitelist: [{ github: 'alice' }],
            },
          },
        }),
      );

      const res = await oauthRequest('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env);
      expect(res.status).toBe(200);
      const body = await res.json();
      // Verified user 'octocat' is not in whitelist ['alice']
      expect(body.tasks).toHaveLength(0);
    });

    it('poll respects blacklist with verified github_username', async () => {
      const env = setupOAuthEnv();
      stubGitHubAuth(42, 'blocked-user');

      await store.createTask(
        makeTask({
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            summarizer: {
              ...DEFAULT_REVIEW_CONFIG.summarizer,
              blacklist: [{ github: 'blocked-user' }],
            },
          },
        }),
      );

      const res = await oauthRequest('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tasks).toHaveLength(0);
    });

    it('claim stores github_user_id from verified identity', async () => {
      const env = setupOAuthEnv();
      stubGitHubAuth(42, 'octocat');

      await store.createTask(makeTask());

      const res = await oauthRequest(
        'POST',
        '/api/tasks/task-1/claim',
        { agent_id: 'agent-1', role: 'summary' },
        env,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.claimed).toBe(true);

      // Verify the claim record has github_user_id
      const claim = await store.getClaim('task-1:agent-1:summary');
      expect(claim).not.toBeNull();
      expect(claim!.github_user_id).toBe(42);
    });

    it('claim uses verified github_username for eligibility checks', async () => {
      const env = setupOAuthEnv();
      stubGitHubAuth(42, 'octocat');

      await store.createTask(
        makeTask({
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            summarizer: {
              ...DEFAULT_REVIEW_CONFIG.summarizer,
              whitelist: [{ github: 'octocat' }],
            },
          },
        }),
      );

      const res = await oauthRequest(
        'POST',
        '/api/tasks/task-1/claim',
        { agent_id: 'agent-1', role: 'summary' },
        env,
      );
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.claimed).toBe(true);
    });

    it('claim rejects when verified username not eligible', async () => {
      const env = setupOAuthEnv();
      stubGitHubAuth(42, 'octocat');

      await store.createTask(
        makeTask({
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            summarizer: {
              ...DEFAULT_REVIEW_CONFIG.summarizer,
              whitelist: [{ github: 'alice' }],
            },
          },
        }),
      );

      const res = await oauthRequest(
        'POST',
        '/api/tasks/task-1/claim',
        { agent_id: 'agent-1', role: 'summary' },
        env,
      );
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('CLAIM_CONFLICT');
      expect(body.error.message).toContain('not in the summary whitelist');
    });

    it('poll uses verified github_username for review queue eligibility', async () => {
      const env = setupOAuthEnv();
      stubGitHubAuth(42, 'octocat');

      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          task_type: 'review',
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            reviewer: {
              ...DEFAULT_REVIEW_CONFIG.reviewer,
              whitelist: [{ github: 'octocat' }],
            },
          },
        }),
      );

      const res = await oauthRequest('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].role).toBe('review');
    });

    it('poll filters review tasks when verified username not in whitelist', async () => {
      const env = setupOAuthEnv();
      stubGitHubAuth(42, 'octocat');

      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          task_type: 'review',
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            reviewer: {
              ...DEFAULT_REVIEW_CONFIG.reviewer,
              whitelist: [{ github: 'alice' }],
            },
          },
        }),
      );

      const res = await oauthRequest('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tasks).toHaveLength(0);
    });

    it('poll works without OAuth when whitelist has only agent entries', async () => {
      const env = createOAuthApp();

      await store.createTask(
        makeTask({
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            summarizer: {
              ...DEFAULT_REVIEW_CONFIG.summarizer,
              whitelist: [{ agent: 'agent-1' }],
            },
          },
        }),
      );

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' }, env);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
    });

    it('claim stores no github_user_id when OAuth is not enforced', async () => {
      // No OAuth credentials — uses API key auth, verifiedIdentity is undefined
      const env = createOAuthApp();
      await store.createTask(makeTask());

      const res = await request(
        'POST',
        '/api/tasks/task-1/claim',
        { agent_id: 'agent-1', role: 'summary' },
        env,
      );
      expect(res.status).toBe(200);

      const claim = await store.getClaim('task-1:agent-1:summary');
      expect(claim).not.toBeNull();
      expect(claim!.github_user_id).toBeUndefined();
    });
  });
});
