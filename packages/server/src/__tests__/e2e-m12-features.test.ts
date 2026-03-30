/**
 * E2E tests for M12 features — exercises new capabilities end-to-end.
 *
 * Features tested:
 * - Private repo task filtering at poll time (#282)
 * - Structured error code responses (#283)
 * - Rate limiting under load (#234)
 * - Task TTL cleanup (#285)
 * - Structured logging / X-Request-Id header (#289)
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { stubOAuthFetch, OAUTH_HEADERS } from './test-oauth-helper.js';
import { generateKeyPairSync } from 'node:crypto';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';
import { MemoryDataStore } from '../store/memory.js';
import { resetTimeoutThrottle, POLL_RATE_LIMIT } from '../routes/tasks.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import type { Env } from '../types.js';
import { createTestApp } from './helpers/test-server.js';
import { MockGitHubService } from './helpers/github-mock.js';
import { MockAgent } from './helpers/mock-agent.js';
import { VALID_SUMMARY_TEXT } from './helpers/test-constants.js';

// ── Setup ────────────────────────────────────────────────────

let TEST_PEM: string;
beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  TEST_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
});

function getMockEnv(): Env {
  return {
    GITHUB_WEBHOOK_SECRET: 'test-secret',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: TEST_PEM,
    WEB_URL: 'https://test.opencara.com',
    GITHUB_CLIENT_ID: 'cid',
    GITHUB_CLIENT_SECRET: 'csecret',
  };
}

describe('M12 Feature E2E Tests', () => {
  let store: MemoryDataStore;
  let app: ReturnType<typeof createTestApp>;
  let env: Env;
  function agent(id: string): MockAgent {
    return new MockAgent(id, app, env);
  }

  beforeEach(() => {
    stubOAuthFetch();
    resetTimeoutThrottle();
    resetRateLimits();
    store = new MemoryDataStore();
    app = createTestApp(store, new MockGitHubService());
    env = getMockEnv();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // ═══════════════════════════════════════════════════════════
  // A. Private Repo Task Filtering (#282)
  // ═══════════════════════════════════════════════════════════

  describe('A. Private repo task filtering', () => {
    async function injectPrivateTask(opts?: {
      owner?: string;
      repo?: string;
      prNumber?: number;
      reviewCount?: number;
    }): Promise<string> {
      const config = {
        ...DEFAULT_REVIEW_CONFIG,
        agentCount: opts?.reviewCount ?? 1,
      };

      const res = await app.request(
        '/test/events/pr',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({
            owner: opts?.owner ?? 'private-org',
            repo: opts?.repo ?? 'secret-repo',
            pr_number: opts?.prNumber ?? 1,
            private: true,
            config,
          }),
        },
        env,
      );
      const body = (await res.json()) as { created: boolean; task_id?: string };
      expect(body.created).toBe(true);
      return body.task_id!;
    }

    async function injectPublicTask(opts?: { prNumber?: number }): Promise<string> {
      const res = await app.request(
        '/test/events/pr',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({
            owner: 'public-org',
            repo: 'open-repo',
            pr_number: opts?.prNumber ?? 2,
            config: DEFAULT_REVIEW_CONFIG,
          }),
        },
        env,
      );
      const body = (await res.json()) as { created: boolean; task_id?: string };
      expect(body.created).toBe(true);
      return body.task_id!;
    }

    it('agent without repos declaration cannot see private tasks', async () => {
      await injectPrivateTask();

      const a = agent('no-repos-agent');
      const tasks = await a.poll();
      expect(tasks).toHaveLength(0);
    });

    it('agent with matching repos can see private tasks', async () => {
      const taskId = await injectPrivateTask();

      // Poll with repos list (sent via raw request since MockAgent doesn't support repos)
      const res = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({
            agent_id: 'private-agent',
            repos: ['private-org/secret-repo'],
          }),
        },
        env,
      );
      const body = (await res.json()) as { tasks: Array<{ task_id: string }> };
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].task_id).toBe(taskId);
    });

    it('agent with non-matching repos cannot see private tasks', async () => {
      await injectPrivateTask();

      const res = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({
            agent_id: 'wrong-repos-agent',
            repos: ['other-org/other-repo'],
          }),
        },
        env,
      );
      const body = (await res.json()) as { tasks: unknown[] };
      expect(body.tasks).toHaveLength(0);
    });

    it('public tasks are visible to all agents regardless of repos', async () => {
      const taskId = await injectPublicTask();

      // Agent without repos declaration
      const a = agent('any-agent');
      const tasks = await a.poll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].task_id).toBe(taskId);
    });

    it('mixed public and private: agent sees only public + matching private', async () => {
      await injectPrivateTask({ prNumber: 10 });
      await injectPublicTask({ prNumber: 20 });
      await injectPrivateTask({ owner: 'other-org', repo: 'other-repo', prNumber: 30 });

      // Poll with repos matching first private task only
      const res = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({
            agent_id: 'mixed-agent',
            repos: ['private-org/secret-repo'],
          }),
        },
        env,
      );
      const body = (await res.json()) as { tasks: Array<{ pr_number: number }> };
      expect(body.tasks).toHaveLength(2);
      const prNumbers = body.tasks.map((t) => t.pr_number).sort();
      expect(prNumbers).toEqual([10, 20]);
    });

    it('private task can be claimed and completed normally', async () => {
      const taskId = await injectPrivateTask();

      // Poll with matching repos
      const res = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({
            agent_id: 'private-worker',
            repos: ['private-org/secret-repo'],
          }),
        },
        env,
      );
      const body = (await res.json()) as { tasks: Array<{ task_id: string; role: string }> };
      expect(body.tasks).toHaveLength(1);

      // Claim and complete
      const a = agent('private-worker');
      const claim = await a.claim(taskId, 'summary');
      expect(claim.claimed).toBe(true);

      const result = await a.submitResult(taskId, 'summary', VALID_SUMMARY_TEXT, 'approve', 500);
      expect(result.status).toBe(200);

      const task = await store.getTask(taskId);
      expect(task).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // B. Structured Error Codes (#283)
  // ═══════════════════════════════════════════════════════════

  describe('B. Structured error codes', () => {
    it('claim on non-existent task returns TASK_NOT_FOUND', async () => {
      const a = agent('err-agent');
      const result = await a.claim('nonexistent-id', 'summary');
      expect(result.claimed).toBe(false);
      if ('error' in result) {
        expect(result.error.code).toBe('TASK_NOT_FOUND');
        expect(typeof result.error.message).toBe('string');
      }
      expect(result._status).toBe(404);
    });

    it('duplicate claim returns CLAIM_CONFLICT', async () => {
      const { taskId } = (await agent('a1').injectPR()) as { taskId: string };

      const a1 = agent('claimer-1');
      const c1 = await a1.claim(taskId, 'summary');
      expect(c1.claimed).toBe(true);

      const a2 = agent('claimer-2');
      const c2 = await a2.claim(taskId, 'summary');
      expect(c2.claimed).toBe(false);
      if ('error' in c2) {
        expect(c2.error.code).toBe('CLAIM_CONFLICT');
      }
      expect(c2._status).toBe(409);
    });

    it('missing required fields returns INVALID_REQUEST', async () => {
      const res = await app.request(
        '/api/tasks/any/claim',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({ agent_id: 'a' }), // missing role
        },
        env,
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('reject with no active claim returns CLAIM_NOT_FOUND', async () => {
      const res = await app.request(
        '/api/tasks/nonexistent/reject',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({ agent_id: 'ghost', reason: 'test' }),
        },
        env,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('CLAIM_NOT_FOUND');
    });

    it('error report with no active claim returns CLAIM_NOT_FOUND', async () => {
      const res = await app.request(
        '/api/tasks/nonexistent/error',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({ agent_id: 'ghost', error: 'crash' }),
        },
        env,
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('CLAIM_NOT_FOUND');
    });

    it('result after task deleted (post-completion) returns 404', async () => {
      const { taskId } = (await agent('a').injectPR()) as { taskId: string };
      const a = agent('dup-agent');
      await a.claim(taskId, 'summary');
      await a.submitResult(taskId, 'summary', VALID_SUMMARY_TEXT, 'approve');

      // Task + claims deleted after post — second submit returns 404
      const r2 = await a.submitResult(taskId, 'summary', VALID_SUMMARY_TEXT);
      expect(r2.status).toBe(404);
    });

    it('all error responses include {error: {code, message}} shape', async () => {
      // 400: missing agent_id on poll
      const r400 = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({}),
        },
        env,
      );
      expect(r400.status).toBe(400);
      const b400 = (await r400.json()) as { error?: { code: string; message: string } };
      expect(b400.error).toBeDefined();
      expect(b400.error!.code).toBeDefined();
      expect(b400.error!.message).toBeDefined();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // C. Rate Limiting (#234)
  // ═══════════════════════════════════════════════════════════

  describe('C. Rate limiting', () => {
    it('exceeding poll rate limit returns 429 with Retry-After', async () => {
      const a = agent('spammer');

      // Send requests up to the limit
      for (let i = 0; i < POLL_RATE_LIMIT.maxRequests; i++) {
        const tasks = await a.poll();
        expect(Array.isArray(tasks)).toBe(true);
      }

      // Next request should be rate limited
      const res = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({ agent_id: 'spammer' }),
        },
        env,
      );
      expect(res.status).toBe(429);

      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(body.error.message).toContain('Rate limit');

      // Retry-After header present
      const retryAfter = res.headers.get('Retry-After');
      expect(retryAfter).toBeDefined();
      expect(Number(retryAfter)).toBeGreaterThan(0);
    });

    it('different agents have independent rate limits', async () => {
      const a1 = agent('agent-fast');
      const a2 = agent('agent-slow');

      // Fill up a1's rate limit
      for (let i = 0; i < POLL_RATE_LIMIT.maxRequests; i++) {
        await a1.poll();
      }

      // a2 should still work
      const tasks = await a2.poll();
      expect(Array.isArray(tasks)).toBe(true);
    });

    it('rate limit applies to claim endpoint too', async () => {
      const { MUTATION_RATE_LIMIT } = await import('../routes/tasks.js');
      const { taskId } = (await agent('a').injectPR({ reviewCount: 100 })) as { taskId: string };

      // Single agent rapid-fire claims to exhaust rate limit
      for (let i = 0; i < MUTATION_RATE_LIMIT.maxRequests; i++) {
        await app.request(
          `/api/tasks/${taskId}/claim`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
            body: JSON.stringify({ agent_id: 'single-flood', role: 'review' }),
          },
          env,
        );
      }

      const limitedRes = await app.request(
        `/api/tasks/${taskId}/claim`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({ agent_id: 'single-flood', role: 'review' }),
        },
        env,
      );
      expect(limitedRes.status).toBe(429);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // D. Task TTL Cleanup (#285)
  // ═══════════════════════════════════════════════════════════

  describe('D. Task TTL cleanup', () => {
    it('cleanupTerminalTasks removes old completed tasks', async () => {
      // Create a completed task with old created_at
      const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
      await store.createTask({
        id: 'old-completed',
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        pr_url: 'https://github.com/org/repo/pull/1',
        diff_url: 'https://github.com/org/repo/pull/1.diff',
        base_ref: 'main',
        head_ref: 'feat',
        review_count: 1,
        prompt: 'Review.',
        timeout_at: oldTimestamp + 600_000,
        status: 'completed',
        github_installation_id: 999,
        private: false,
        config: DEFAULT_REVIEW_CONFIG,
        created_at: oldTimestamp,
      });

      // Create a recent completed task
      await store.createTask({
        id: 'recent-completed',
        owner: 'org',
        repo: 'repo',
        pr_number: 2,
        pr_url: 'https://github.com/org/repo/pull/2',
        diff_url: 'https://github.com/org/repo/pull/2.diff',
        base_ref: 'main',
        head_ref: 'feat2',
        review_count: 1,
        prompt: 'Review.',
        timeout_at: Date.now() + 600_000,
        status: 'completed',
        github_installation_id: 999,
        private: false,
        config: DEFAULT_REVIEW_CONFIG,
        created_at: Date.now(),
      });

      // Create old pending task (should NOT be cleaned up — not terminal)
      await store.createTask({
        id: 'old-pending',
        owner: 'org',
        repo: 'repo',
        pr_number: 3,
        pr_url: 'https://github.com/org/repo/pull/3',
        diff_url: 'https://github.com/org/repo/pull/3.diff',
        base_ref: 'main',
        head_ref: 'feat3',
        review_count: 1,
        prompt: 'Review.',
        timeout_at: oldTimestamp + 600_000,
        status: 'pending',
        github_installation_id: 999,
        private: false,
        config: DEFAULT_REVIEW_CONFIG,
        created_at: oldTimestamp,
      });

      const deleted = await store.cleanupTerminalTasks();
      expect(deleted).toBe(1);

      // Old completed: gone
      expect(await store.getTask('old-completed')).toBeNull();
      // Recent completed: still here
      expect(await store.getTask('recent-completed')).not.toBeNull();
      // Old pending: still here (not terminal)
      expect(await store.getTask('old-pending')).not.toBeNull();
    });

    it('cleanup also removes associated claims', async () => {
      const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
      await store.createTask({
        id: 'old-task',
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        pr_url: 'https://github.com/org/repo/pull/1',
        diff_url: 'https://github.com/org/repo/pull/1.diff',
        base_ref: 'main',
        head_ref: 'feat',
        review_count: 1,
        prompt: 'Review.',
        timeout_at: oldTimestamp + 600_000,
        status: 'completed',
        github_installation_id: 999,
        private: false,
        config: DEFAULT_REVIEW_CONFIG,
        created_at: oldTimestamp,
      });
      await store.createClaim({
        id: 'old-task:agent-1',
        task_id: 'old-task',
        agent_id: 'agent-1',
        role: 'summary',
        status: 'completed',
        review_text: 'Done. Looks good overall.',
        created_at: oldTimestamp,
      });

      await store.cleanupTerminalTasks();

      expect(await store.getTask('old-task')).toBeNull();
      const claims = await store.getClaims('old-task');
      expect(claims).toHaveLength(0);
    });

    it('cleanup removes timeout and failed tasks too', async () => {
      const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
      const baseTask = {
        owner: 'org',
        repo: 'repo',
        pr_url: 'https://github.com/org/repo/pull/1',
        diff_url: 'https://github.com/org/repo/pull/1.diff',
        base_ref: 'main',
        head_ref: 'feat',
        review_count: 1,
        prompt: 'Review.',
        timeout_at: oldTimestamp + 600_000,
        github_installation_id: 999,
        private: false,
        config: DEFAULT_REVIEW_CONFIG,
        created_at: oldTimestamp,
      };

      await store.createTask({ ...baseTask, id: 'old-timeout', pr_number: 1, status: 'timeout' });
      await store.createTask({ ...baseTask, id: 'old-failed', pr_number: 2, status: 'failed' });

      const deleted = await store.cleanupTerminalTasks();
      expect(deleted).toBe(2);
      expect(await store.getTask('old-timeout')).toBeNull();
      expect(await store.getTask('old-failed')).toBeNull();
    });

    it('custom TTL controls cleanup threshold', async () => {
      const shortTtlStore = new MemoryDataStore(1); // 1 day TTL
      const twoDaysAgo = Date.now() - 2 * 24 * 60 * 60 * 1000;

      await shortTtlStore.createTask({
        id: 'short-ttl-task',
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        pr_url: 'https://github.com/org/repo/pull/1',
        diff_url: 'https://github.com/org/repo/pull/1.diff',
        base_ref: 'main',
        head_ref: 'feat',
        review_count: 1,
        prompt: 'Review.',
        timeout_at: twoDaysAgo + 600_000,
        status: 'completed',
        github_installation_id: 999,
        private: false,
        config: DEFAULT_REVIEW_CONFIG,
        created_at: twoDaysAgo,
      });

      const deleted = await shortTtlStore.cleanupTerminalTasks();
      expect(deleted).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // E. Structured Logging / X-Request-Id (#289)
  // ═══════════════════════════════════════════════════════════

  describe('E. X-Request-Id header', () => {
    it('poll response includes X-Request-Id header', async () => {
      const res = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({ agent_id: 'header-test' }),
        },
        env,
      );
      expect(res.status).toBe(200);

      const requestId = res.headers.get('X-Request-Id');
      expect(requestId).toBeDefined();
      expect(requestId).not.toBe('');
      // Should be a valid UUID format
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('claim response includes X-Request-Id header', async () => {
      const { taskId } = (await agent('a').injectPR()) as { taskId: string };

      const res = await app.request(
        `/api/tasks/${taskId}/claim`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({ agent_id: 'header-test', role: 'summary' }),
        },
        env,
      );
      expect(res.status).toBe(200);

      const requestId = res.headers.get('X-Request-Id');
      expect(requestId).toBeDefined();
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('error response includes X-Request-Id header', async () => {
      const res = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({}), // missing agent_id
        },
        env,
      );
      expect(res.status).toBe(400);

      const requestId = res.headers.get('X-Request-Id');
      expect(requestId).toBeDefined();
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('each request gets a unique X-Request-Id', async () => {
      const ids = new Set<string>();
      for (let i = 0; i < 5; i++) {
        resetRateLimits(); // Prevent rate limiting
        const res = await app.request(
          '/api/tasks/poll',
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
            body: JSON.stringify({ agent_id: `unique-test-${i}` }),
          },
          env,
        );
        ids.add(res.headers.get('X-Request-Id')!);
      }
      expect(ids.size).toBe(5);
    });

    it('health endpoint also includes X-Request-Id', async () => {
      const res = await app.request('/', { method: 'GET' }, env);
      expect(res.status).toBe(200);

      const requestId = res.headers.get('X-Request-Id');
      expect(requestId).toBeDefined();
      expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // F. Combined M12 Scenarios
  // ═══════════════════════════════════════════════════════════

  describe('F. Combined M12 scenarios', () => {
    it('private task lifecycle with structured errors and request IDs', async () => {
      // Inject private task
      const res = await app.request(
        '/test/events/pr',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({
            owner: 'corp',
            repo: 'internal',
            pr_number: 42,
            private: true,
            config: DEFAULT_REVIEW_CONFIG,
          }),
        },
        env,
      );
      const { task_id: taskId } = (await res.json()) as { task_id: string };

      // Agent without repos: empty poll with X-Request-Id
      const pollRes = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({ agent_id: 'outsider' }),
        },
        env,
      );
      expect(pollRes.status).toBe(200);
      expect(pollRes.headers.get('X-Request-Id')).toBeDefined();
      const pollBody = (await pollRes.json()) as { tasks: unknown[] };
      expect(pollBody.tasks).toHaveLength(0);

      // Agent with repos: sees the task
      const authPollRes = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({ agent_id: 'insider', repos: ['corp/internal'] }),
        },
        env,
      );
      const authPollBody = (await authPollRes.json()) as {
        tasks: Array<{ task_id: string }>;
      };
      expect(authPollBody.tasks).toHaveLength(1);

      // Claim and complete with structured response
      const claimRes = await app.request(
        `/api/tasks/${taskId}/claim`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({ agent_id: 'insider', role: 'summary' }),
        },
        env,
      );
      expect(claimRes.status).toBe(200);
      expect(claimRes.headers.get('X-Request-Id')).toBeDefined();
      const claimBody = (await claimRes.json()) as { claimed: boolean };
      expect(claimBody.claimed).toBe(true);

      // Duplicate claim returns structured error
      const dupRes = await app.request(
        `/api/tasks/${taskId}/claim`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({ agent_id: 'outsider', role: 'summary' }),
        },
        env,
      );
      expect(dupRes.status).toBe(409);
      expect(dupRes.headers.get('X-Request-Id')).toBeDefined();
      const dupBody = (await dupRes.json()) as { error: { code: string } };
      expect(dupBody.error.code).toBe('CLAIM_CONFLICT');
    });
  });
});
