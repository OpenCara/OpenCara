import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubOAuthFetch, OAUTH_HEADERS } from './test-oauth-helper.js';
import { DEFAULT_REVIEW_CONFIG, type ReviewTask } from '@opencara/shared';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import { resetTimeoutThrottle, PREFERRED_REVIEW_GRACE_PERIOD_MS } from '../routes/tasks.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import { AGENT_REJECTION_THRESHOLD } from '../store/constants.js';
import { computeAgentReputation, effectiveGracePeriod } from '../reputation.js';

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

/**
 * Stub fetch to return a specific github_user_id from OAuth verification.
 */
function stubOAuthFetchWithUserId(githubUserId: number, login = 'test-user'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      status: 200,
      json: () => Promise.resolve({ user: { id: githubUserId, login } }),
    }),
  );
}

/**
 * Create reputation events for an agent that yield a specific Wilson score tier.
 */
function makeReputationEvents(
  agentId: string,
  upvotes: number,
  downvotes: number,
): Array<{
  posted_review_id: number;
  agent_id: string;
  operator_github_user_id: number;
  github_user_id: number;
  delta: number;
  created_at: string;
}> {
  const events = [];
  const now = new Date().toISOString();
  for (let i = 0; i < upvotes; i++) {
    events.push({
      posted_review_id: 1,
      agent_id: agentId,
      operator_github_user_id: 1000,
      github_user_id: 2000 + i,
      delta: 1,
      created_at: now,
    });
  }
  for (let i = 0; i < downvotes; i++) {
    events.push({
      posted_review_id: 1,
      agent_id: agentId,
      operator_github_user_id: 1000,
      github_user_id: 3000 + i,
      delta: -1,
      created_at: now,
    });
  }
  return events;
}

describe('Reputation-based eligibility integration', () => {
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

  // ── Grace period cooldown tests ──────────────────────────────
  //
  // Reputation no longer extends the visibility grace window — it now
  // contributes to the weighted-random shuffle in batch-poll dispatch
  // (see src/routes/tasks.ts). What remains here is the cooldown
  // multiplier, which still extends grace for agents that recently
  // completed a review (prevents back-to-back same-agent claims).

  describe('grace period — cooldown multiplier', () => {
    it('agent that just completed a review does not see a preferred-mismatch task during extended grace', async () => {
      // Record a completed claim to simulate recent review (2 minutes ago)
      await store.createTask(makeTask({ id: 'old-task', status: 'completed' }));
      await store.createClaim({
        id: 'old-task:recent-agent:review',
        task_id: 'old-task',
        agent_id: 'recent-agent',
        role: 'review',
        status: 'completed',
        created_at: Date.now() - 2 * 60_000, // 2 min ago
      });

      // Effective grace = 30s * 2.0 (cooldown) = 60s
      const lastCompleted = await store.getAgentLastCompletedClaimAt('recent-agent');
      const effGrace = effectiveGracePeriod(PREFERRED_REVIEW_GRACE_PERIOD_MS, lastCompleted);
      expect(effGrace).toBe(PREFERRED_REVIEW_GRACE_PERIOD_MS * 2); // 60s

      // Task created 45s ago — past default (30s) but within cooldown-extended (60s)
      await store.createTask(
        makeTask({
          id: 'review-2',
          task_type: 'review',
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            preferredModels: ['gpt-5.4'],
            preferredTools: [],
          },
          created_at: Date.now() - 45_000,
        }),
      );

      resetRateLimits();
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'recent-agent',
        model: 'claude-4',
        tool: 'claude',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tasks: unknown[] };
      // Agent should NOT see task (cooldown-extended grace 60s > 45s elapsed)
      expect(body.tasks).toHaveLength(0);
    });

    it('reputation no longer affects grace visibility', async () => {
      // Very-bad-reputation agent — used to get a huge grace multiplier.
      const events = makeReputationEvents('bad-rep', 5, 50);
      for (const e of events) {
        await store.recordReputationEvent(e);
      }
      const repEvents = await store.getAgentReputationEvents('bad-rep', 0);
      const score = computeAgentReputation(repEvents);
      expect(score).toBeLessThan(0.4);

      // Grace should be the plain base (no cooldown, no reputation factor).
      const effGrace = effectiveGracePeriod(PREFERRED_REVIEW_GRACE_PERIOD_MS, null);
      expect(effGrace).toBe(PREFERRED_REVIEW_GRACE_PERIOD_MS);

      // Task created 45s ago — past default 30s grace → visible.
      await store.createTask(
        makeTask({
          id: 'review-rep',
          task_type: 'review',
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            preferredModels: ['gpt-5.4'],
            preferredTools: [],
          },
          created_at: Date.now() - 45_000,
        }),
      );

      resetRateLimits();
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'bad-rep',
        model: 'claude-4',
        tool: 'claude',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tasks: unknown[] };
      expect(body.tasks).toHaveLength(1);
    });
  });

  // ── Account-level blocking tests ─────────────────────────────

  describe('account-level blocking', () => {
    it('blocks agent when same github_user_id has rejections across different agent_ids', async () => {
      // Record rejections under different agent_ids but same github_user_id
      const now = Date.now();
      for (let i = 0; i < AGENT_REJECTION_THRESHOLD; i++) {
        await store.recordAgentRejection(`rotating-agent-${i}`, 'too_short', now, 42);
      }

      // The default OAuth stub returns github_user_id=42
      resetRateLimits();
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'new-rotating-agent', // different agent_id
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('AGENT_BLOCKED');
    });

    it('does not block agent when github_user_id has fewer than threshold rejections', async () => {
      const now = Date.now();
      for (let i = 0; i < AGENT_REJECTION_THRESHOLD - 1; i++) {
        await store.recordAgentRejection(`rotating-agent-${i}`, 'too_short', now, 42);
      }

      resetRateLimits();
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'new-rotating-agent',
      });
      expect(res.status).toBe(200);
    });

    it('account-level block also applies to claim endpoint', async () => {
      const now = Date.now();
      for (let i = 0; i < AGENT_REJECTION_THRESHOLD; i++) {
        await store.recordAgentRejection(`rotating-agent-${i}`, 'too_short', now, 42);
      }

      await store.createTask(makeTask());

      resetRateLimits();
      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'new-rotating-agent',
        role: 'review',
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('AGENT_BLOCKED');
    });

    it('does not affect different github_user_id', async () => {
      const now = Date.now();
      // Record rejections for user_id=42 (default OAuth mock)
      for (let i = 0; i < AGENT_REJECTION_THRESHOLD; i++) {
        await store.recordAgentRejection(`rotating-agent-${i}`, 'too_short', now, 42);
      }

      // Use a different github_user_id
      stubOAuthFetchWithUserId(999, 'different-user');
      resetRateLimits();
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'new-rotating-agent',
      });
      expect(res.status).toBe(200);
    });

    it('existing agent-level blocking still works independently', async () => {
      // Record rejections for the same agent_id (no github_user_id)
      const now = Date.now();
      for (let i = 0; i < AGENT_REJECTION_THRESHOLD; i++) {
        await store.recordAgentRejection('same-agent', 'too_short', now);
      }

      resetRateLimits();
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'same-agent',
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('AGENT_BLOCKED');
    });
  });

  // ── DataStore method tests ────────────────────────────────────

  describe('MemoryDataStore — getAgentLastCompletedClaimAt', () => {
    it('returns null for agent with no completed claims', async () => {
      const result = await store.getAgentLastCompletedClaimAt('unknown-agent');
      expect(result).toBeNull();
    });

    it('returns the most recent completed claim timestamp', async () => {
      await store.createTask(makeTask({ id: 'task-a', status: 'completed' }));
      await store.createTask(makeTask({ id: 'task-b', status: 'completed' }));

      await store.createClaim({
        id: 'task-a:agent-1:review',
        task_id: 'task-a',
        agent_id: 'agent-1',
        role: 'review',
        status: 'completed',
        created_at: 1000,
      });
      await store.createClaim({
        id: 'task-b:agent-1:review',
        task_id: 'task-b',
        agent_id: 'agent-1',
        role: 'review',
        status: 'completed',
        created_at: 2000,
      });

      const result = await store.getAgentLastCompletedClaimAt('agent-1');
      expect(result).toBe(2000);
    });

    it('ignores non-completed claims', async () => {
      await store.createTask(makeTask({ id: 'task-a' }));
      await store.createClaim({
        id: 'task-a:agent-1:review',
        task_id: 'task-a',
        agent_id: 'agent-1',
        role: 'review',
        status: 'pending',
        created_at: 1000,
      });

      const result = await store.getAgentLastCompletedClaimAt('agent-1');
      expect(result).toBeNull();
    });

    it('ignores other agents', async () => {
      await store.createTask(makeTask({ id: 'task-a', status: 'completed' }));
      await store.createClaim({
        id: 'task-a:other-agent:review',
        task_id: 'task-a',
        agent_id: 'other-agent',
        role: 'review',
        status: 'completed',
        created_at: 1000,
      });

      const result = await store.getAgentLastCompletedClaimAt('agent-1');
      expect(result).toBeNull();
    });
  });

  describe('MemoryDataStore — countAccountRejections', () => {
    it('counts rejections by github_user_id across agent_ids', async () => {
      const now = Date.now();
      await store.recordAgentRejection('agent-a', 'too_short', now, 42);
      await store.recordAgentRejection('agent-b', 'too_short', now, 42);
      await store.recordAgentRejection('agent-c', 'too_short', now, 99);

      expect(await store.countAccountRejections(42, now - 1000)).toBe(2);
      expect(await store.countAccountRejections(99, now - 1000)).toBe(1);
      expect(await store.countAccountRejections(123, now - 1000)).toBe(0);
    });

    it('respects time window', async () => {
      const old = Date.now() - 100_000;
      const recent = Date.now();

      await store.recordAgentRejection('agent-a', 'too_short', old, 42);
      await store.recordAgentRejection('agent-b', 'too_short', recent, 42);

      expect(await store.countAccountRejections(42, recent - 1000)).toBe(1);
      expect(await store.countAccountRejections(42, old - 1000)).toBe(2);
    });
  });
});
