import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_REVIEW_CONFIG, type ReviewTask } from '@opencara/shared';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import { resetTimeoutThrottle } from '../routes/tasks.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
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
};

describe('Request Validation (Zod)', () => {
  let store: MemoryDataStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetTimeoutThrottle();
    resetRateLimits();
    store = new MemoryDataStore();
    app = createApp(store);
  });

  function request(method: string, path: string, body?: unknown, raw?: boolean) {
    return app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: raw ? (body as string) : body !== undefined ? JSON.stringify(body) : undefined,
      },
      mockEnv,
    );
  }

  // ── Poll validation ──────────────────────────────────────────

  describe('POST /api/tasks/poll', () => {
    it('rejects missing agent_id', async () => {
      const res = await request('POST', '/api/tasks/poll', {});
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toContain('agent_id');
    });

    it('rejects empty string agent_id', async () => {
      const res = await request('POST', '/api/tasks/poll', { agent_id: '' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toContain('agent_id');
    });

    it('rejects numeric agent_id', async () => {
      const res = await request('POST', '/api/tasks/poll', { agent_id: 123 });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('rejects invalid roles', async () => {
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'a1',
        roles: ['admin'],
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('rejects malformed JSON', async () => {
      const res = await request('POST', '/api/tasks/poll', 'not-json{', true);
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toContain('Malformed JSON');
    });

    it('accepts valid poll request with all fields', async () => {
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        roles: ['review', 'summary'],
        repos: ['org/repo'],
        model: 'claude',
        tool: 'claude',
        thinking: '10000',
        synthesize_repos: { mode: 'whitelist', list: ['org/repo'] },
      });
      expect(res.status).toBe(200);
    });

    it('accepts valid poll request with minimal fields', async () => {
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      expect(res.status).toBe(200);
    });

    it('rejects thinking field exceeding 256 characters', async () => {
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        thinking: 'x'.repeat(257),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('strips extra fields from poll request', async () => {
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        malicious_field: 'should_be_stripped',
      });
      expect(res.status).toBe(200);
    });

    it('rejects invalid synthesize_repos mode', async () => {
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        synthesize_repos: { mode: 'invalid_mode' },
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });
  });

  // ── Claim validation ─────────────────────────────────────────

  describe('POST /api/tasks/:taskId/claim', () => {
    it('rejects missing agent_id', async () => {
      const res = await request('POST', '/api/tasks/task-1/claim', { role: 'review' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
      expect(body.error.message).toContain('agent_id');
    });

    it('rejects missing role', async () => {
      const res = await request('POST', '/api/tasks/task-1/claim', { agent_id: 'a1' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('rejects invalid role value', async () => {
      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'a1',
        role: 'admin',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('accepts valid claim request', async () => {
      await store.createTask(makeTask());
      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'summary',
        model: 'claude',
        tool: 'claude',
      });
      expect(res.status).toBe(200);
    });

    it('accepts claim request with thinking field', async () => {
      await store.createTask(makeTask({ id: 'task-thinking' }));
      const res = await request('POST', '/api/tasks/task-thinking/claim', {
        agent_id: 'agent-1',
        role: 'summary',
        model: 'claude',
        tool: 'claude',
        thinking: '10000',
      });
      expect(res.status).toBe(200);
      const claim = await store.getClaim('task-thinking:agent-1:summary');
      expect(claim?.thinking).toBe('10000');
    });
  });

  // ── Result validation ────────────────────────────────────────

  describe('POST /api/tasks/:taskId/result', () => {
    it('rejects missing agent_id', async () => {
      const res = await request('POST', '/api/tasks/task-1/result', {
        type: 'review',
        review_text: 'good review text content',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('rejects missing type', async () => {
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'a1',
        review_text: 'good review text content',
      });
      expect(res.status).toBe(400);
    });

    it('rejects empty review_text', async () => {
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'a1',
        type: 'review',
        review_text: '',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('review_text');
    });

    it('rejects whitespace-only review_text', async () => {
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'a1',
        type: 'review',
        review_text: '     \n\t   ',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('review_text');
    });

    it('rejects too-short review_text (< 10 chars after trimming)', async () => {
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'a1',
        type: 'review',
        review_text: 'LGTM',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('review_text');
      expect(body.error.message).toContain('10 characters');
    });

    it('rejects too-long review_text (> 100K chars)', async () => {
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'a1',
        type: 'review',
        review_text: 'x'.repeat(100_001),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('review_text');
      expect(body.error.message).toContain('100000');
    });

    it('trims review_text before length validation', async () => {
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'a1',
        type: 'review',
        review_text: '   short   ',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('review_text');
    });

    it('accepts review_text at minimum length (10 chars)', async () => {
      await store.createTask(makeTask({ review_count: 2, queue: 'review' }));
      await store.createClaim({
        id: 'task-1:agent-1:review',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'review',
        status: 'pending',
        created_at: Date.now(),
      });

      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-1',
        type: 'review',
        review_text: 'Looks good!',
      });
      expect(res.status).toBe(200);
    });

    it('rejects invalid type value', async () => {
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'a1',
        type: 'admin',
        review_text: 'test review content',
      });
      expect(res.status).toBe(400);
    });

    it('rejects invalid verdict value', async () => {
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'a1',
        type: 'review',
        review_text: 'test review content',
        verdict: 'merge_now',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('rejects negative tokens_used', async () => {
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'a1',
        type: 'review',
        review_text: 'test review content',
        tokens_used: -5,
      });
      expect(res.status).toBe(400);
    });

    it('rejects non-integer tokens_used', async () => {
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'a1',
        type: 'review',
        review_text: 'test review content',
        tokens_used: 1.5,
      });
      expect(res.status).toBe(400);
    });

    it('accepts case-insensitive verdicts', async () => {
      for (const verdict of ['APPROVE', 'Approve', 'REQUEST_CHANGES', 'Comment']) {
        resetRateLimits();
        store = new MemoryDataStore();
        app = createApp(store);
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
          verdict,
        });
        expect(res.status).toBe(200);
      }
    });

    it('rejects Infinity tokens_used', async () => {
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'a1',
        type: 'review',
        review_text: 'test review content',
        tokens_used: Infinity,
      });
      expect(res.status).toBe(400);
    });

    it('accepts valid result with verdict', async () => {
      await store.createTask(makeTask());
      // Claim first
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
        tokens_used: 1500,
      });
      expect(res.status).toBe(200);
    });
  });

  // ── Reject validation ────────────────────────────────────────

  describe('POST /api/tasks/:taskId/reject', () => {
    it('rejects missing agent_id', async () => {
      const res = await request('POST', '/api/tasks/task-1/reject', { reason: 'too complex' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('rejects missing reason', async () => {
      const res = await request('POST', '/api/tasks/task-1/reject', { agent_id: 'a1' });
      expect(res.status).toBe(400);
    });

    it('rejects empty reason', async () => {
      const res = await request('POST', '/api/tasks/task-1/reject', {
        agent_id: 'a1',
        reason: '',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('reason');
    });

    it('accepts valid reject request', async () => {
      await store.createTask(makeTask());
      await store.createClaim({
        id: 'task-1:agent-1:summary',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'summary',
        status: 'pending',
        created_at: Date.now(),
      });

      const res = await request('POST', '/api/tasks/task-1/reject', {
        agent_id: 'agent-1',
        reason: 'Too complex for my tool',
      });
      expect(res.status).toBe(200);
    });
  });

  // ── Error validation ─────────────────────────────────────────

  describe('POST /api/tasks/:taskId/error', () => {
    it('rejects missing agent_id', async () => {
      const res = await request('POST', '/api/tasks/task-1/error', { error: 'crashed' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('rejects missing error field', async () => {
      const res = await request('POST', '/api/tasks/task-1/error', { agent_id: 'a1' });
      expect(res.status).toBe(400);
    });

    it('rejects empty error string', async () => {
      const res = await request('POST', '/api/tasks/task-1/error', {
        agent_id: 'a1',
        error: '',
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.message).toContain('error');
    });

    it('accepts valid error request', async () => {
      await store.createTask(makeTask());
      await store.createClaim({
        id: 'task-1:agent-1:summary',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'summary',
        status: 'pending',
        created_at: Date.now(),
      });

      const res = await request('POST', '/api/tasks/task-1/error', {
        agent_id: 'agent-1',
        error: 'Tool crashed unexpectedly',
      });
      expect(res.status).toBe(200);
    });
  });
});
