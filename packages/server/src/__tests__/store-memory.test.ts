import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDataStore } from '../store/memory.js';
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

describe('MemoryDataStore', () => {
  let store: MemoryDataStore;

  beforeEach(() => {
    store = new MemoryDataStore();
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

    // ── createTaskIfNotExists ────────────────────────────────

    it('createTaskIfNotExists creates task when no active task exists', async () => {
      const task = makeTask({ id: 'new-1', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(true);
      expect(await store.getTask('new-1')).not.toBeNull();
    });

    it('createTaskIfNotExists returns false when pending task exists for same PR', async () => {
      await store.createTask(
        makeTask({ id: 'existing', owner: 'org', repo: 'repo', pr_number: 10 }),
      );
      const task = makeTask({ id: 'dup', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(false);
      expect(await store.getTask('dup')).toBeNull();
    });

    it('createTaskIfNotExists returns false when reviewing task exists for same PR', async () => {
      await store.createTask(
        makeTask({
          id: 'existing',
          owner: 'org',
          repo: 'repo',
          pr_number: 10,
          status: 'reviewing',
        }),
      );
      const task = makeTask({ id: 'dup', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(false);
      expect(await store.getTask('dup')).toBeNull();
    });

    it('createTaskIfNotExists succeeds when existing task is completed', async () => {
      await store.createTask(
        makeTask({ id: 'old', owner: 'org', repo: 'repo', pr_number: 10, status: 'completed' }),
      );
      const task = makeTask({ id: 'new-1', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(true);
      expect(await store.getTask('new-1')).not.toBeNull();
    });

    it('createTaskIfNotExists succeeds when existing task is for different PR', async () => {
      await store.createTask(makeTask({ id: 'other', owner: 'org', repo: 'repo', pr_number: 5 }));
      const task = makeTask({ id: 'new-1', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(true);
    });

    it('createTaskIfNotExists succeeds when existing task is for different repo', async () => {
      await store.createTask(
        makeTask({ id: 'other', owner: 'org', repo: 'other-repo', pr_number: 10 }),
      );
      const task = makeTask({ id: 'new-1', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(true);
    });

    it('createTaskIfNotExists succeeds when existing task has timeout status', async () => {
      await store.createTask(
        makeTask({ id: 'old', owner: 'org', repo: 'repo', pr_number: 10, status: 'timeout' }),
      );
      const task = makeTask({ id: 'new-1', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(true);
    });

    it('createTaskIfNotExists succeeds when existing task has failed status', async () => {
      await store.createTask(
        makeTask({ id: 'old', owner: 'org', repo: 'repo', pr_number: 10, status: 'failed' }),
      );
      const task = makeTask({ id: 'new-1', owner: 'org', repo: 'repo', pr_number: 10 });
      const created = await store.createTaskIfNotExists(task);
      expect(created).toBe(true);
    });
  });

  // ── Claims ─────────────────────────────────────────────────

  describe('claims', () => {
    it('creates and retrieves claims', async () => {
      const claim = makeClaim();
      const created = await store.createClaim(claim);
      expect(created).toBe(true);
      const claims = await store.getClaims('task-1');
      expect(claims).toHaveLength(1);
      expect(claims[0]).toEqual(claim);
    });

    it('returns empty array when no claims', async () => {
      expect(await store.getClaims('task-1')).toEqual([]);
    });

    it('returns false for duplicate (task_id, agent_id)', async () => {
      await store.createClaim(makeClaim());
      const result = await store.createClaim(makeClaim());
      expect(result).toBe(false);
      // Only one claim exists
      const claims = await store.getClaims('task-1');
      expect(claims).toHaveLength(1);
    });

    it('allows different agents on same task', async () => {
      await store.createClaim(makeClaim({ id: 'task-1:agent-1', agent_id: 'agent-1' }));
      const result = await store.createClaim(
        makeClaim({ id: 'task-1:agent-2', agent_id: 'agent-2' }),
      );
      expect(result).toBe(true);
      const claims = await store.getClaims('task-1');
      expect(claims).toHaveLength(2);
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

  // ── Completed reviews (atomic increment) ────────────────

  describe('incrementCompletedReviews', () => {
    it('increments completed_reviews and returns new count and queue', async () => {
      await store.createTask(makeTask({ completed_reviews: 0, queue: 'review' }));
      const result = await store.incrementCompletedReviews('task-1');
      expect(result).toEqual({ newCount: 1, queue: 'review' });
      const task = await store.getTask('task-1');
      expect(task?.completed_reviews).toBe(1);
    });

    it('returns null for nonexistent task', async () => {
      const result = await store.incrementCompletedReviews('nonexistent');
      expect(result).toBeNull();
    });

    it('increments from existing count', async () => {
      await store.createTask(makeTask({ completed_reviews: 2, queue: 'summary' }));
      const result = await store.incrementCompletedReviews('task-1');
      expect(result).toEqual({ newCount: 3, queue: 'summary' });
    });

    it('increments from undefined completed_reviews', async () => {
      await store.createTask(makeTask({ completed_reviews: undefined, queue: 'review' }));
      const result = await store.incrementCompletedReviews('task-1');
      expect(result).toEqual({ newCount: 1, queue: 'review' });
    });
  });

  // ── Review slot (atomic increment) ──────────────────────

  describe('claimReviewSlot', () => {
    it('claims slot when below max', async () => {
      await store.createTask(makeTask({ review_claims: 0 }));
      const result = await store.claimReviewSlot('task-1', 2);
      expect(result).toBe(true);
      const task = await store.getTask('task-1');
      expect(task?.review_claims).toBe(1);
    });

    it('rejects when at max slots', async () => {
      await store.createTask(makeTask({ review_claims: 2 }));
      const result = await store.claimReviewSlot('task-1', 2);
      expect(result).toBe(false);
      const task = await store.getTask('task-1');
      expect(task?.review_claims).toBe(2);
    });

    it('rejects when above max slots', async () => {
      await store.createTask(makeTask({ review_claims: 3 }));
      const result = await store.claimReviewSlot('task-1', 2);
      expect(result).toBe(false);
    });

    it('returns false for nonexistent task', async () => {
      const result = await store.claimReviewSlot('nonexistent', 2);
      expect(result).toBe(false);
    });

    it('increments atomically up to max', async () => {
      await store.createTask(makeTask({ review_claims: 0 }));
      expect(await store.claimReviewSlot('task-1', 2)).toBe(true);
      expect(await store.claimReviewSlot('task-1', 2)).toBe(true);
      expect(await store.claimReviewSlot('task-1', 2)).toBe(false);
      const task = await store.getTask('task-1');
      expect(task?.review_claims).toBe(2);
    });

    it('handles undefined review_claims as 0', async () => {
      await store.createTask(makeTask());
      // review_claims not set in makeTask defaults → should be treated as 0
      const result = await store.claimReviewSlot('task-1', 1);
      expect(result).toBe(true);
    });
  });

  describe('releaseReviewSlot', () => {
    it('decrements review_claims', async () => {
      await store.createTask(makeTask({ review_claims: 2 }));
      const result = await store.releaseReviewSlot('task-1');
      expect(result).toBe(true);
      const task = await store.getTask('task-1');
      expect(task?.review_claims).toBe(1);
    });

    it('returns false when review_claims is 0', async () => {
      await store.createTask(makeTask({ review_claims: 0 }));
      const result = await store.releaseReviewSlot('task-1');
      expect(result).toBe(false);
    });

    it('returns false for nonexistent task', async () => {
      const result = await store.releaseReviewSlot('nonexistent');
      expect(result).toBe(false);
    });

    it('claim then release returns to original count', async () => {
      await store.createTask(makeTask({ review_claims: 1 }));
      await store.claimReviewSlot('task-1', 3);
      expect((await store.getTask('task-1'))?.review_claims).toBe(2);
      await store.releaseReviewSlot('task-1');
      expect((await store.getTask('task-1'))?.review_claims).toBe(1);
    });
  });

  // ── Summary claim (CAS) ─────────────────────────────────

  describe('claimSummarySlot / releaseSummarySlot', () => {
    it('claims summary slot when task is in summary queue', async () => {
      await store.createTask(makeTask({ queue: 'summary' }));
      const result = await store.claimSummarySlot('task-1', 'agent-a');
      expect(result).toBe(true);
      const task = await store.getTask('task-1');
      expect(task?.queue).toBe('finished');
      expect(task?.summary_agent_id).toBe('agent-a');
    });

    it('rejects second claim when already claimed', async () => {
      await store.createTask(makeTask({ queue: 'summary' }));
      await store.claimSummarySlot('task-1', 'agent-a');
      const result = await store.claimSummarySlot('task-1', 'agent-b');
      expect(result).toBe(false);
    });

    it('rejects claim when task is not in summary queue', async () => {
      await store.createTask(makeTask({ queue: 'review' }));
      const result = await store.claimSummarySlot('task-1', 'agent-a');
      expect(result).toBe(false);
    });

    it('rejects claim for nonexistent task', async () => {
      const result = await store.claimSummarySlot('nonexistent', 'agent-a');
      expect(result).toBe(false);
    });

    it('releaseSummarySlot returns task to summary queue', async () => {
      await store.createTask(makeTask({ queue: 'summary' }));
      await store.claimSummarySlot('task-1', 'agent-a');
      await store.releaseSummarySlot('task-1');
      const task = await store.getTask('task-1');
      expect(task?.queue).toBe('summary');
      expect(task?.summary_agent_id).toBeUndefined();
    });

    it('releaseSummarySlot allows new claim', async () => {
      await store.createTask(makeTask({ queue: 'summary' }));
      await store.claimSummarySlot('task-1', 'agent-a');
      await store.releaseSummarySlot('task-1');
      const result = await store.claimSummarySlot('task-1', 'agent-b');
      expect(result).toBe(true);
      const task = await store.getTask('task-1');
      expect(task?.summary_agent_id).toBe('agent-b');
    });

    it('releaseSummarySlot is no-op for nonexistent task', async () => {
      await store.releaseSummarySlot('nonexistent'); // should not throw
    });

    it('claims are independent per task', async () => {
      await store.createTask(makeTask({ id: 'task-1', queue: 'summary' }));
      await store.createTask(makeTask({ id: 'task-2', queue: 'summary' }));
      await store.claimSummarySlot('task-1', 'agent-a');
      const result = await store.claimSummarySlot('task-2', 'agent-b');
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

  // ── cleanupTerminalTasks ─────────────────────────────────────

  describe('cleanupTerminalTasks', () => {
    it('deletes terminal tasks older than default TTL', async () => {
      const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000; // 8 days ago
      await store.createTask(
        makeTask({ id: 'old-completed', status: 'completed', created_at: oldTime }),
      );
      await store.createTask(
        makeTask({ id: 'old-timeout', status: 'timeout', created_at: oldTime }),
      );
      await store.createTask(makeTask({ id: 'old-failed', status: 'failed', created_at: oldTime }));

      const deleted = await store.cleanupTerminalTasks();
      expect(deleted).toBe(3);
      expect(await store.getTask('old-completed')).toBeNull();
      expect(await store.getTask('old-timeout')).toBeNull();
      expect(await store.getTask('old-failed')).toBeNull();
    });

    it('does not delete terminal tasks within TTL', async () => {
      const recentTime = Date.now() - 1 * 24 * 60 * 60 * 1000; // 1 day ago
      await store.createTask(
        makeTask({ id: 'recent', status: 'completed', created_at: recentTime }),
      );

      const deleted = await store.cleanupTerminalTasks();
      expect(deleted).toBe(0);
      expect(await store.getTask('recent')).not.toBeNull();
    });

    it('does not delete active tasks even if old', async () => {
      const oldTime = Date.now() - 30 * 24 * 60 * 60 * 1000; // 30 days ago
      await store.createTask(makeTask({ id: 'pending', status: 'pending', created_at: oldTime }));
      await store.createTask(
        makeTask({ id: 'reviewing', status: 'reviewing', created_at: oldTime }),
      );

      const deleted = await store.cleanupTerminalTasks();
      expect(deleted).toBe(0);
    });

    it('respects custom TTL', async () => {
      const customStore = new MemoryDataStore(1); // 1 day TTL
      const oldTime = Date.now() - 2 * 24 * 60 * 60 * 1000; // 2 days ago

      await customStore.createTask(
        makeTask({ id: 'old', status: 'completed', created_at: oldTime }),
      );

      const deleted = await customStore.cleanupTerminalTasks();
      expect(deleted).toBe(1);
    });

    it('also deletes associated claims', async () => {
      const oldTime = Date.now() - 8 * 24 * 60 * 60 * 1000;
      await store.createTask(makeTask({ id: 'old', status: 'completed', created_at: oldTime }));
      await store.createClaim(
        makeClaim({ id: 'old:agent-1', task_id: 'old', agent_id: 'agent-1' }),
      );

      await store.cleanupTerminalTasks();
      expect(await store.getClaims('old')).toEqual([]);
    });

    it('returns 0 when no tasks exist', async () => {
      const deleted = await store.cleanupTerminalTasks();
      expect(deleted).toBe(0);
    });
  });

  // ── reclaimAbandonedClaims ──────────────────────────────────

  describe('reclaimAbandonedClaims', () => {
    const STALE_THRESHOLD = 180_000; // 3 minutes

    it('frees pending claims from stale agents', async () => {
      const now = Date.now();
      await store.createTask(makeTask({ review_claims: 1, queue: 'review' }));
      await store.createClaim(
        makeClaim({ id: 'task-1:stale-agent:review', agent_id: 'stale-agent', role: 'review' }),
      );
      // Agent last seen 5 minutes ago (stale)
      await store.setAgentLastSeen('stale-agent', now - 300_000);

      const freed = await store.reclaimAbandonedClaims(STALE_THRESHOLD);
      expect(freed).toBe(1);

      const claim = await store.getClaim('task-1:stale-agent:review');
      expect(claim?.status).toBe('error');

      // Review slot should be released
      const task = await store.getTask('task-1');
      expect(task?.review_claims).toBe(0);
    });

    it('does not free claims from active agents', async () => {
      const now = Date.now();
      await store.createTask(makeTask({ review_claims: 1, queue: 'review' }));
      await store.createClaim(
        makeClaim({ id: 'task-1:active-agent:review', agent_id: 'active-agent', role: 'review' }),
      );
      // Agent last seen 1 minute ago (active)
      await store.setAgentLastSeen('active-agent', now - 60_000);

      const freed = await store.reclaimAbandonedClaims(STALE_THRESHOLD);
      expect(freed).toBe(0);

      const claim = await store.getClaim('task-1:active-agent:review');
      expect(claim?.status).toBe('pending');
    });

    it('frees claims from agents with no heartbeat when claim is old', async () => {
      const now = Date.now();
      await store.createTask(makeTask({ review_claims: 1, queue: 'review' }));
      await store.createClaim(
        makeClaim({
          id: 'task-1:ghost:review',
          agent_id: 'ghost',
          role: 'review',
          created_at: now - 300_000, // claim created 5 min ago
        }),
      );
      // No setAgentLastSeen call — agent never seen

      const freed = await store.reclaimAbandonedClaims(STALE_THRESHOLD);
      expect(freed).toBe(1);

      const claim = await store.getClaim('task-1:ghost:review');
      expect(claim?.status).toBe('error');
    });

    it('does not free claims from agents with no heartbeat when claim is recent', async () => {
      await store.createTask(makeTask({ review_claims: 1, queue: 'review' }));
      await store.createClaim(
        makeClaim({
          id: 'task-1:ghost:review',
          agent_id: 'ghost',
          role: 'review',
          created_at: Date.now(), // claim just created
        }),
      );
      // No heartbeat

      const freed = await store.reclaimAbandonedClaims(STALE_THRESHOLD);
      expect(freed).toBe(0);

      const claim = await store.getClaim('task-1:ghost:review');
      expect(claim?.status).toBe('pending');
    });

    it('does not touch completed or error claims', async () => {
      await store.createTask(makeTask());
      await store.createClaim(
        makeClaim({
          id: 'task-1:agent-1:review',
          agent_id: 'agent-1',
          role: 'review',
          status: 'completed',
        }),
      );
      // Agent is stale
      await store.setAgentLastSeen('agent-1', Date.now() - 300_000);

      const freed = await store.reclaimAbandonedClaims(STALE_THRESHOLD);
      expect(freed).toBe(0);
    });

    it('freed review slot can be re-claimed by another agent', async () => {
      const now = Date.now();
      await store.createTask(makeTask({ review_claims: 1, queue: 'review' }));
      await store.createClaim(
        makeClaim({ id: 'task-1:stale:review', agent_id: 'stale', role: 'review' }),
      );
      await store.setAgentLastSeen('stale', now - 300_000);

      await store.reclaimAbandonedClaims(STALE_THRESHOLD);

      // Now another agent should be able to claim the slot
      const slotClaimed = await store.claimReviewSlot('task-1', 1);
      expect(slotClaimed).toBe(true);
    });

    it('returns 0 when no pending claims exist', async () => {
      const freed = await store.reclaimAbandonedClaims(STALE_THRESHOLD);
      expect(freed).toBe(0);
    });
  });

  // ── reclaimAbandonedSummarySlots ────────────────────────────

  describe('reclaimAbandonedSummarySlots', () => {
    const STALE_THRESHOLD = 300_000; // 5 minutes

    it('frees summary slot from stale agent', async () => {
      const now = Date.now();
      await store.createTask(makeTask({ queue: 'finished', summary_agent_id: 'stale-synth' }));
      await store.setAgentLastSeen('stale-synth', now - 600_000);

      const freed = await store.reclaimAbandonedSummarySlots(STALE_THRESHOLD);
      expect(freed).toBe(1);

      const task = await store.getTask('task-1');
      expect(task?.queue).toBe('summary');
      expect(task?.summary_agent_id).toBeUndefined();
    });

    it('does not free summary slot from active agent', async () => {
      const now = Date.now();
      await store.createTask(makeTask({ queue: 'finished', summary_agent_id: 'active-synth' }));
      await store.setAgentLastSeen('active-synth', now - 60_000);

      const freed = await store.reclaimAbandonedSummarySlots(STALE_THRESHOLD);
      expect(freed).toBe(0);

      const task = await store.getTask('task-1');
      expect(task?.queue).toBe('finished');
    });

    it('frees summary slot from agent with no heartbeat when task is old', async () => {
      const now = Date.now();
      await store.createTask(
        makeTask({
          queue: 'finished',
          summary_agent_id: 'ghost',
          created_at: now - 600_000, // task created 10 min ago
        }),
      );
      // No heartbeat

      const freed = await store.reclaimAbandonedSummarySlots(STALE_THRESHOLD);
      expect(freed).toBe(1);

      const task = await store.getTask('task-1');
      expect(task?.queue).toBe('summary');
    });

    it('does not free summary slot from agent with no heartbeat when task is recent', async () => {
      await store.createTask(
        makeTask({
          queue: 'finished',
          summary_agent_id: 'ghost',
          created_at: Date.now(), // task just created
        }),
      );
      // No heartbeat

      const freed = await store.reclaimAbandonedSummarySlots(STALE_THRESHOLD);
      expect(freed).toBe(0);

      const task = await store.getTask('task-1');
      expect(task?.queue).toBe('finished');
    });

    it('freed summary slot can be claimed by another agent', async () => {
      const now = Date.now();
      await store.createTask(makeTask({ queue: 'finished', summary_agent_id: 'stale' }));
      await store.setAgentLastSeen('stale', now - 600_000);

      await store.reclaimAbandonedSummarySlots(STALE_THRESHOLD);

      // New agent should be able to claim summary
      const claimed = await store.claimSummarySlot('task-1', 'new-agent');
      expect(claimed).toBe(true);
      const task = await store.getTask('task-1');
      expect(task?.summary_agent_id).toBe('new-agent');
    });

    it('does not affect tasks not in finished queue', async () => {
      await store.createTask(makeTask({ queue: 'review' }));

      const freed = await store.reclaimAbandonedSummarySlots(STALE_THRESHOLD);
      expect(freed).toBe(0);
    });

    it('returns 0 when no tasks exist', async () => {
      const freed = await store.reclaimAbandonedSummarySlots(STALE_THRESHOLD);
      expect(freed).toBe(0);
    });
  });
});
