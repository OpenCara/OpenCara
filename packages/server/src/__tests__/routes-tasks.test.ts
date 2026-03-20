import { describe, it, expect, beforeEach } from 'vitest';
import { DEFAULT_REVIEW_CONFIG, type ReviewTask } from '@opencara/shared';
import { MemoryTaskStore } from '../store/memory.js';
import { createApp } from '../index.js';

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
    github_installation_id: 123,
    config: DEFAULT_REVIEW_CONFIG,
    created_at: Date.now(),
    ...overrides,
  };
}

const mockEnv = {
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: 'test-key',
  TASK_STORE: {} as KVNamespace,
  WEB_URL: 'https://test.com',
};

describe('Task Routes', () => {
  let store: MemoryTaskStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    store = new MemoryTaskStore();
    app = createApp(store);
  });

  function request(method: string, path: string, body?: unknown) {
    return app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      },
      mockEnv,
    );
  }

  // ── Poll ─────────────────────────────────────────────────

  describe('POST /api/tasks/poll', () => {
    it('returns empty tasks when nothing available', async () => {
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tasks).toEqual([]);
    });

    it('returns available tasks', async () => {
      await store.createTask(makeTask());
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].task_id).toBe('task-1');
      expect(body.tasks[0].role).toBe('summary'); // review_count=1 → summary only
    });

    it('does not return tasks where agent already has a claim', async () => {
      await store.createTask(makeTask());
      await store.createClaim({
        id: 'task-1:agent-1',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'summary',
        status: 'pending',
        created_at: Date.now(),
      });

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(0);
    });

    it('does not return timed-out tasks', async () => {
      await store.createTask(makeTask({ timeout_at: Date.now() - 1000 }));
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(0);
    });

    it('returns review role for multi-agent tasks', async () => {
      await store.createTask(makeTask({ review_count: 3 }));
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks[0].role).toBe('review');
    });

    it('returns 400 when agent_id is missing', async () => {
      const res = await request('POST', '/api/tasks/poll', {});
      expect(res.status).toBe(400);
    });
  });

  // ── Claim ────────────────────────────────────────────────

  describe('POST /api/tasks/:taskId/claim', () => {
    it('claims a task successfully', async () => {
      await store.createTask(makeTask());
      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'summary',
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.claimed).toBe(true);
    });

    it('rejects claim for nonexistent task', async () => {
      const res = await request('POST', '/api/tasks/nope/claim', {
        agent_id: 'agent-1',
        role: 'summary',
      });
      const body = await res.json();
      expect(body.claimed).toBe(false);
      expect(body.reason).toContain('not found');
    });

    it('rejects claim with wrong role', async () => {
      await store.createTask(makeTask()); // review_count=1 → only summary
      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'review',
      });
      const body = await res.json();
      expect(body.claimed).toBe(false);
    });

    it('rejects double claim from same agent', async () => {
      await store.createTask(makeTask({ review_count: 3 }));
      // First claim succeeds
      await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'review',
      });
      // Second claim fails
      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'review',
      });
      const body = await res.json();
      expect(body.claimed).toBe(false);
    });

    it('includes reviews when claiming summary role', async () => {
      await store.createTask(makeTask({ review_count: 2 }));
      // Add a completed review
      await store.createClaim({
        id: 'task-1:reviewer',
        task_id: 'task-1',
        agent_id: 'reviewer',
        role: 'review',
        status: 'completed',
        review_text: 'LGTM',
        verdict: 'approve',
        created_at: Date.now(),
      });
      // Claim summary
      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'summarizer',
        role: 'summary',
      });
      const body = await res.json();
      expect(body.claimed).toBe(true);
      expect(body.reviews).toHaveLength(1);
      expect(body.reviews[0].review_text).toBe('LGTM');
    });

    it('updates task status to reviewing on first claim', async () => {
      await store.createTask(makeTask());
      await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'summary',
      });
      const task = await store.getTask('task-1');
      expect(task?.status).toBe('reviewing');
    });
  });

  // ── Result ───────────────────────────────────────────────

  describe('POST /api/tasks/:taskId/result', () => {
    it('stores review result', async () => {
      await store.createTask(makeTask({ review_count: 3 }));
      await store.createClaim({
        id: 'task-1:agent-1',
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
        verdict: 'approve',
        tokens_used: 500,
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.success).toBe(true);

      const claims = await store.getClaims('task-1');
      expect(claims[0].status).toBe('completed');
      expect(claims[0].review_text).toBe('Looks good!');
    });

    it('rejects result for nonexistent claim', async () => {
      await store.createTask(makeTask());
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-unknown',
        type: 'review',
        review_text: 'test',
      });
      expect(res.status).toBe(404);
    });

    it('rejects result for already completed claim', async () => {
      await store.createTask(makeTask());
      await store.createClaim({
        id: 'task-1:agent-1',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'summary',
        status: 'completed',
        created_at: Date.now(),
      });

      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-1',
        type: 'summary',
        review_text: 'test',
      });
      expect(res.status).toBe(409);
    });
  });

  // ── Reject / Error ───────────────────────────────────────

  describe('POST /api/tasks/:taskId/reject', () => {
    it('marks claim as rejected', async () => {
      await store.createClaim({
        id: 'task-1:agent-1',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'review',
        status: 'pending',
        created_at: Date.now(),
      });

      const res = await request('POST', '/api/tasks/task-1/reject', {
        agent_id: 'agent-1',
        reason: 'Cannot access diff',
      });
      expect(res.status).toBe(200);

      const claims = await store.getClaims('task-1');
      expect(claims[0].status).toBe('rejected');
    });
  });

  describe('POST /api/tasks/:taskId/error', () => {
    it('marks claim as error', async () => {
      await store.createClaim({
        id: 'task-1:agent-1',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'review',
        status: 'pending',
        created_at: Date.now(),
      });

      const res = await request('POST', '/api/tasks/task-1/error', {
        agent_id: 'agent-1',
        error: 'Tool crashed',
      });
      expect(res.status).toBe(200);

      const claims = await store.getClaims('task-1');
      expect(claims[0].status).toBe('error');
    });
  });

  // ── Multi-agent flow ─────────────────────────────────────

  describe('multi-agent review flow', () => {
    it('review_count=3: 2 reviews → summary becomes available', async () => {
      await store.createTask(makeTask({ review_count: 3 }));

      // Agent A polls → gets review role
      let res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-a' });
      let body = await res.json();
      expect(body.tasks[0].role).toBe('review');

      // Agent A claims review
      await request('POST', '/api/tasks/task-1/claim', { agent_id: 'agent-a', role: 'review' });

      // Agent B polls → gets review role
      res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-b' });
      body = await res.json();
      expect(body.tasks[0].role).toBe('review');

      // Agent B claims review
      await request('POST', '/api/tasks/task-1/claim', { agent_id: 'agent-b', role: 'review' });

      // Agent C polls → no summary yet (reviews not complete)
      res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-c' });
      body = await res.json();
      expect(body.tasks).toHaveLength(0);

      // Agent A submits review
      await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-a',
        type: 'review',
        review_text: 'Review A',
        verdict: 'approve',
      });

      // Still no summary (only 1 of 2 reviews done)
      res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-c' });
      body = await res.json();
      expect(body.tasks).toHaveLength(0);

      // Agent B submits review
      await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-b',
        type: 'review',
        review_text: 'Review B',
        verdict: 'comment',
      });

      // Now summary is available
      res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-c' });
      body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].role).toBe('summary');
    });
  });
});
