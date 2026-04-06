import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubOAuthFetch, OAUTH_HEADERS } from './test-oauth-helper.js';
import { DEFAULT_REVIEW_CONFIG, type ReviewTask } from '@opencara/shared';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import { resetTimeoutThrottle } from '../routes/tasks.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import { AGENT_REJECTION_THRESHOLD, AGENT_REJECTION_WINDOW_MS } from '../store/constants.js';
import { VALID_SUMMARY_TEXT } from './helpers/test-constants.js';

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
    task_type: 'review',
    feature: 'review',
    group_id: 'group-1',
    ...overrides,
  };
}

const mockEnv = {
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: 'test-key',
  WEB_URL: 'https://test.com',
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csecret',
};

describe('Abuse Tracking', () => {
  let store: MemoryDataStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    stubOAuthFetch();
    resetTimeoutThrottle();
    resetRateLimits();
    store = new MemoryDataStore();
    app = createApp(store);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function request(method: string, path: string, body?: unknown) {
    return app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      mockEnv,
    );
  }

  describe('rejection recording', () => {
    it('records a rejection when review_text is too short', async () => {
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'bad-agent',
        type: 'review',
        review_text: 'hi',
      });
      expect(res.status).toBe(400);

      const count = await store.countAgentRejections(
        'bad-agent',
        Date.now() - AGENT_REJECTION_WINDOW_MS,
      );
      expect(count).toBe(1);
    });

    it('records a rejection when review_text is too long', async () => {
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'bad-agent',
        type: 'review',
        review_text: 'x'.repeat(100_001),
      });
      expect(res.status).toBe(400);

      const count = await store.countAgentRejections(
        'bad-agent',
        Date.now() - AGENT_REJECTION_WINDOW_MS,
      );
      expect(count).toBe(1);
    });

    it('does not record rejection for other validation errors (e.g. missing type)', async () => {
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'good-agent',
        review_text: 'This is a valid length review text',
      });
      expect(res.status).toBe(400);

      const count = await store.countAgentRejections(
        'good-agent',
        Date.now() - AGENT_REJECTION_WINDOW_MS,
      );
      expect(count).toBe(0);
    });

    it('does not record rejection for valid review_text submissions', async () => {
      await store.createTask(makeTask());
      await store.createClaim({
        id: 'task-1:agent-1:summary',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'summary',
        status: 'pending',
        created_at: Date.now(),
      });
      await store.updateTask('task-1', { summary_agent_id: 'agent-1', queue: 'finished' });

      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-1',
        type: 'summary',
        review_text: VALID_SUMMARY_TEXT,
        verdict: 'approve',
      });
      expect(res.status).toBe(200);

      const count = await store.countAgentRejections(
        'agent-1',
        Date.now() - AGENT_REJECTION_WINDOW_MS,
      );
      expect(count).toBe(0);
    });
  });

  describe('agent blocking', () => {
    async function rejectNTimes(agentId: string, n: number): Promise<void> {
      for (let i = 0; i < n; i++) {
        resetRateLimits();
        await request('POST', `/api/tasks/task-${i}/result`, {
          agent_id: agentId,
          type: 'review',
          review_text: 'hi',
        });
      }
    }

    it('blocks agent on poll after exceeding rejection threshold', async () => {
      await rejectNTimes('spammer', AGENT_REJECTION_THRESHOLD);
      resetRateLimits();

      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'spammer',
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('AGENT_BLOCKED');
    });

    it('blocks agent on claim after exceeding rejection threshold', async () => {
      await store.createTask(makeTask());
      await rejectNTimes('spammer', AGENT_REJECTION_THRESHOLD);
      resetRateLimits();

      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'spammer',
        role: 'summary',
      });
      expect(res.status).toBe(403);
      const body = await res.json();
      expect(body.error.code).toBe('AGENT_BLOCKED');
    });

    it('does not block agent below rejection threshold', async () => {
      await rejectNTimes('agent-ok', AGENT_REJECTION_THRESHOLD - 1);
      resetRateLimits();

      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-ok',
      });
      expect(res.status).toBe(200);
    });

    it('does not block unrelated agents from a different account', async () => {
      // Record rejections directly with a specific github_user_id to avoid
      // OAuth cache interference (API requests cache the token → user mapping)
      const now = Date.now();
      for (let i = 0; i < AGENT_REJECTION_THRESHOLD; i++) {
        await store.recordAgentRejection('bad-agent', 'too_short', now, 9999);
      }
      resetRateLimits();

      // Default OAuth stub returns github_user_id=42, different from 9999
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'good-agent',
      });
      expect(res.status).toBe(200);
    });

    it('allows agent again after rejection window expires', async () => {
      // Manually record old rejections outside the window
      const oldTimestamp = Date.now() - AGENT_REJECTION_WINDOW_MS - 1000;
      for (let i = 0; i < AGENT_REJECTION_THRESHOLD; i++) {
        await store.recordAgentRejection('agent-expired', 'too_short', oldTimestamp);
      }

      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-expired',
      });
      expect(res.status).toBe(200);
    });
  });

  describe('MemoryDataStore rejection methods', () => {
    it('recordAgentRejection and countAgentRejections work correctly', async () => {
      const now = Date.now();
      await store.recordAgentRejection('agent-1', 'too_short', now);
      await store.recordAgentRejection('agent-1', 'too_long', now);
      await store.recordAgentRejection('agent-2', 'too_short', now);

      expect(await store.countAgentRejections('agent-1', now - 1000)).toBe(2);
      expect(await store.countAgentRejections('agent-2', now - 1000)).toBe(1);
      expect(await store.countAgentRejections('agent-3', now - 1000)).toBe(0);
    });

    it('countAgentRejections respects time window', async () => {
      const old = Date.now() - 100_000;
      const recent = Date.now();

      await store.recordAgentRejection('agent-1', 'too_short', old);
      await store.recordAgentRejection('agent-1', 'too_short', recent);

      expect(await store.countAgentRejections('agent-1', recent - 1000)).toBe(1);
      expect(await store.countAgentRejections('agent-1', old - 1000)).toBe(2);
    });

    it('reset clears rejections', async () => {
      await store.recordAgentRejection('agent-1', 'too_short', Date.now());
      store.reset();
      expect(await store.countAgentRejections('agent-1', 0)).toBe(0);
    });
  });
});
