import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryTaskStore } from '../store/memory.js';
import type { ReviewTask, TaskClaim } from '@opencara/shared';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';

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
    private: false,
    config: DEFAULT_REVIEW_CONFIG,
    created_at: Date.now(),
    ...overrides,
  };
}

function makeClaim(overrides: Partial<TaskClaim> = {}): TaskClaim {
  return {
    id: 'task-1:agent-1',
    task_id: 'task-1',
    agent_id: 'agent-1',
    role: 'review',
    status: 'pending',
    created_at: Date.now(),
    ...overrides,
  };
}

describe('MemoryTaskStore', () => {
  let store: MemoryTaskStore;

  beforeEach(() => {
    store = new MemoryTaskStore();
  });

  // ── Tasks ──────────────────────────────────────────────────

  describe('tasks', () => {
    it('creates and retrieves a task', async () => {
      const task = makeTask();
      await store.createTask(task);
      const retrieved = await store.getTask('task-1');
      expect(retrieved).toEqual(task);
    });

    it('returns null for nonexistent task', async () => {
      expect(await store.getTask('nope')).toBeNull();
    });

    it('returns copies, not references', async () => {
      const task = makeTask();
      await store.createTask(task);
      const a = await store.getTask('task-1');
      const b = await store.getTask('task-1');
      expect(a).not.toBe(b);
    });

    it('lists tasks with no filter', async () => {
      await store.createTask(makeTask({ id: 'a' }));
      await store.createTask(makeTask({ id: 'b' }));
      const all = await store.listTasks();
      expect(all).toHaveLength(2);
    });

    it('filters by status', async () => {
      await store.createTask(makeTask({ id: 'a', status: 'pending' }));
      await store.createTask(makeTask({ id: 'b', status: 'completed' }));
      await store.createTask(makeTask({ id: 'c', status: 'reviewing' }));

      const pending = await store.listTasks({ status: ['pending'] });
      expect(pending).toHaveLength(1);
      expect(pending[0].id).toBe('a');

      const active = await store.listTasks({ status: ['pending', 'reviewing'] });
      expect(active).toHaveLength(2);
    });

    it('filters by timeout_before', async () => {
      const now = Date.now();
      await store.createTask(makeTask({ id: 'expired', timeout_at: now - 1000 }));
      await store.createTask(makeTask({ id: 'active', timeout_at: now + 60000 }));

      const expired = await store.listTasks({ timeout_before: now });
      expect(expired).toHaveLength(1);
      expect(expired[0].id).toBe('expired');
    });

    it('updates a task', async () => {
      await store.createTask(makeTask());
      const updated = await store.updateTask('task-1', { status: 'reviewing' });
      expect(updated).toBe(true);
      const task = await store.getTask('task-1');
      expect(task?.status).toBe('reviewing');
    });

    it('updateTask returns false for nonexistent', async () => {
      expect(await store.updateTask('nope', { status: 'reviewing' })).toBe(false);
    });

    it('deletes a task and its claims', async () => {
      await store.createTask(makeTask());
      await store.createClaim(makeClaim());
      await store.deleteTask('task-1');
      expect(await store.getTask('task-1')).toBeNull();
      expect(await store.getClaims('task-1')).toHaveLength(0);
    });
  });

  // ── Claims ─────────────────────────────────────────────────

  describe('claims', () => {
    it('creates and retrieves claims', async () => {
      const claim = makeClaim();
      await store.createClaim(claim);
      const claims = await store.getClaims('task-1');
      expect(claims).toHaveLength(1);
      expect(claims[0]).toEqual(claim);
    });

    it('returns empty array when no claims', async () => {
      expect(await store.getClaims('task-1')).toEqual([]);
    });

    it('updates a claim', async () => {
      await store.createClaim(makeClaim());
      await store.updateClaim('task-1:agent-1', {
        status: 'completed',
        review_text: 'LGTM',
        verdict: 'approve',
      });
      const claims = await store.getClaims('task-1');
      expect(claims[0].status).toBe('completed');
      expect(claims[0].review_text).toBe('LGTM');
      expect(claims[0].verdict).toBe('approve');
    });

    it('filters claims by taskId', async () => {
      await store.createClaim(makeClaim({ id: 'task-1:a', task_id: 'task-1', agent_id: 'a' }));
      await store.createClaim(makeClaim({ id: 'task-2:b', task_id: 'task-2', agent_id: 'b' }));
      const claims = await store.getClaims('task-1');
      expect(claims).toHaveLength(1);
      expect(claims[0].agent_id).toBe('a');
    });
  });

  // ── Agent last-seen ────────────────────────────────────────

  describe('agent last-seen', () => {
    it('sets and gets last-seen timestamp', async () => {
      const now = Date.now();
      await store.setAgentLastSeen('agent-1', now);
      expect(await store.getAgentLastSeen('agent-1')).toBe(now);
    });

    it('returns null for unknown agent', async () => {
      expect(await store.getAgentLastSeen('nope')).toBeNull();
    });

    it('overwrites previous timestamp', async () => {
      await store.setAgentLastSeen('agent-1', 1000);
      await store.setAgentLastSeen('agent-1', 2000);
      expect(await store.getAgentLastSeen('agent-1')).toBe(2000);
    });
  });

  // ── Summary lock ─────────────────────────────────────────

  describe('summary lock', () => {
    it('acquires lock for first agent', async () => {
      const result = await store.acquireSummaryLock('task-1', 'agent-a');
      expect(result).toBe(true);
    });

    it('rejects second agent when lock is held', async () => {
      await store.acquireSummaryLock('task-1', 'agent-a');
      const result = await store.acquireSummaryLock('task-1', 'agent-b');
      expect(result).toBe(false);
    });

    it('is idempotent for same agent', async () => {
      await store.acquireSummaryLock('task-1', 'agent-a');
      const result = await store.acquireSummaryLock('task-1', 'agent-a');
      expect(result).toBe(true);
    });

    it('checkSummaryLock returns true for lock holder', async () => {
      await store.acquireSummaryLock('task-1', 'agent-a');
      expect(await store.checkSummaryLock('task-1', 'agent-a')).toBe(true);
    });

    it('checkSummaryLock returns false for non-holder', async () => {
      await store.acquireSummaryLock('task-1', 'agent-a');
      expect(await store.checkSummaryLock('task-1', 'agent-b')).toBe(false);
    });

    it('checkSummaryLock returns false when no lock exists', async () => {
      expect(await store.checkSummaryLock('task-1', 'agent-a')).toBe(false);
    });

    it('releaseSummaryLock allows new acquisition', async () => {
      await store.acquireSummaryLock('task-1', 'agent-a');
      await store.releaseSummaryLock('task-1');
      const result = await store.acquireSummaryLock('task-1', 'agent-b');
      expect(result).toBe(true);
    });

    it('deleteTask cleans up summary lock', async () => {
      await store.createTask(makeTask());
      await store.acquireSummaryLock('task-1', 'agent-a');
      await store.deleteTask('task-1');
      expect(await store.checkSummaryLock('task-1', 'agent-a')).toBe(false);
    });

    it('reset() clears summary locks', async () => {
      await store.acquireSummaryLock('task-1', 'agent-a');
      store.reset();
      expect(await store.checkSummaryLock('task-1', 'agent-a')).toBe(false);
    });

    it('locks are independent per task', async () => {
      await store.acquireSummaryLock('task-1', 'agent-a');
      const result = await store.acquireSummaryLock('task-2', 'agent-b');
      expect(result).toBe(true);
    });
  });

  describe('timeout check throttle', () => {
    it('returns 0 when no timestamp set', async () => {
      expect(await store.getTimeoutLastCheck()).toBe(0);
    });

    it('stores and retrieves timestamp', async () => {
      const now = Date.now();
      await store.setTimeoutLastCheck(now);
      expect(await store.getTimeoutLastCheck()).toBe(now);
    });

    it('overwrites previous timestamp', async () => {
      await store.setTimeoutLastCheck(1000);
      await store.setTimeoutLastCheck(2000);
      expect(await store.getTimeoutLastCheck()).toBe(2000);
    });

    it('reset() clears timeout last check', async () => {
      await store.setTimeoutLastCheck(1000);
      store.reset();
      expect(await store.getTimeoutLastCheck()).toBe(0);
    });
  });
});
