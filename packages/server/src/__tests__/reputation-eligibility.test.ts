import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubOAuthFetch, OAUTH_HEADERS } from './test-oauth-helper.js';
import { DEFAULT_REVIEW_CONFIG, type ReviewTask } from '@opencara/shared';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import {
  resetTimeoutThrottle,
  PREFERRED_REVIEW_GRACE_PERIOD_MS,
  PREFERRED_SYNTH_GRACE_PERIOD_MS,
  TARGET_MODEL_GRACE_PERIOD_MS,
} from '../routes/tasks.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import { AGENT_REJECTION_THRESHOLD, REPUTATION_SCORE_WINDOW_MS } from '../store/constants.js';
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

  // ── Grace period multiplier tests ─────────────────────────────

  describe('grace period — reputation multiplier on worker tasks', () => {
    it('proven good agent sees worker task earlier than default grace period', async () => {
      // Create many upvotes so Wilson >= 0.7 → multiplier = 0.5
      const events = makeReputationEvents('good-agent', 50, 5);
      for (const e of events) {
        await store.recordReputationEvent(e);
      }

      // Verify Wilson score is in the "good" range
      const repEvents = await store.getAgentReputationEvents(
        'good-agent',
        REPUTATION_SCORE_WINDOW_MS,
      );
      const score = computeAgentReputation(repEvents);
      expect(score).toBeGreaterThanOrEqual(0.7);

      // Effective grace = 30s * 0.5 * 1.0 = 15s
      const effGrace = effectiveGracePeriod(PREFERRED_REVIEW_GRACE_PERIOD_MS, score, null);
      expect(effGrace).toBeLessThan(PREFERRED_REVIEW_GRACE_PERIOD_MS);

      // Create a task with preferred models that DON'T match this agent
      // Created 20s ago — past the effective grace (15s) but within default (30s)
      await store.createTask(
        makeTask({
          id: 'review-1',
          task_type: 'review',
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            preferredModels: ['gpt-5.4'],
            preferredTools: [],
          },
          created_at: Date.now() - 20_000, // 20s ago
        }),
      );

      resetRateLimits();
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'good-agent',
        model: 'claude-4',
        tool: 'claude',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tasks: unknown[] };
      // Good agent should see the task (effective grace 15s < 20s elapsed)
      expect(body.tasks).toHaveLength(1);
    });

    it('neutral agent does not see worker task during default grace period', async () => {
      // No reputation events → cold start Wilson ~0.15 → penalty multiplier
      // But let's create a "neutral" agent with score ~0.5
      const events = makeReputationEvents('neutral-agent', 20, 10);
      for (const e of events) {
        await store.recordReputationEvent(e);
      }

      const repEvents = await store.getAgentReputationEvents(
        'neutral-agent',
        REPUTATION_SCORE_WINDOW_MS,
      );
      const score = computeAgentReputation(repEvents);
      // Score should be near neutral (0.4-0.7)
      expect(score).toBeGreaterThanOrEqual(0.4);
      expect(score).toBeLessThan(0.7);

      // Effective grace = 30s * 1.0 * 1.0 = 30s (default)
      const effGrace = effectiveGracePeriod(PREFERRED_REVIEW_GRACE_PERIOD_MS, score, null);
      expect(effGrace).toBe(PREFERRED_REVIEW_GRACE_PERIOD_MS);

      // Task created 20s ago — within default grace period
      await store.createTask(
        makeTask({
          id: 'review-1',
          task_type: 'review',
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            preferredModels: ['gpt-5.4'],
            preferredTools: [],
          },
          created_at: Date.now() - 20_000,
        }),
      );

      resetRateLimits();
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'neutral-agent',
        model: 'claude-4',
        tool: 'claude',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tasks: unknown[] };
      // Neutral agent should NOT see the task (30s grace > 20s elapsed)
      expect(body.tasks).toHaveLength(0);
    });

    it('bad agent gets extended grace period (soft-blocking)', async () => {
      // Create downvotes to push Wilson below 0.4 → penalty multiplier
      const events = makeReputationEvents('bad-agent', 5, 50);
      for (const e of events) {
        await store.recordReputationEvent(e);
      }

      const repEvents = await store.getAgentReputationEvents(
        'bad-agent',
        REPUTATION_SCORE_WINDOW_MS,
      );
      const score = computeAgentReputation(repEvents);
      expect(score).toBeLessThan(0.4);

      // Effective grace should be significantly longer than base
      const effGrace = effectiveGracePeriod(PREFERRED_REVIEW_GRACE_PERIOD_MS, score, null);
      expect(effGrace).toBeGreaterThan(PREFERRED_REVIEW_GRACE_PERIOD_MS * 2);

      // Task created 60s ago — past default grace (30s) but within extended grace
      await store.createTask(
        makeTask({
          id: 'review-1',
          task_type: 'review',
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            preferredModels: ['gpt-5.4'],
            preferredTools: [],
          },
          created_at: Date.now() - 60_000,
        }),
      );

      resetRateLimits();
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'bad-agent',
        model: 'claude-4',
        tool: 'claude',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tasks: unknown[] };
      // Bad agent should NOT see the task (extended grace > 60s elapsed)
      expect(body.tasks).toHaveLength(0);
    });
  });

  describe('grace period — cooldown multiplier', () => {
    it('agent that just completed a review gets extended grace period', async () => {
      // Create a neutral-scored agent
      const events = makeReputationEvents('recent-agent', 20, 10);
      for (const e of events) {
        await store.recordReputationEvent(e);
      }

      // Record a completed claim to simulate recent review (2 minutes ago)
      await store.createTask(
        makeTask({
          id: 'old-task',
          status: 'completed',
        }),
      );
      await store.createClaim({
        id: 'old-task:recent-agent:review',
        task_id: 'old-task',
        agent_id: 'recent-agent',
        role: 'review',
        status: 'completed',
        created_at: Date.now() - 2 * 60_000, // 2 min ago
      });

      // Effective grace = 30s * 1.0 (neutral) * 2.0 (cooldown) = 60s
      const repEvents = await store.getAgentReputationEvents(
        'recent-agent',
        REPUTATION_SCORE_WINDOW_MS,
      );
      const score = computeAgentReputation(repEvents);
      const lastCompleted = await store.getAgentLastCompletedClaimAt('recent-agent');
      const effGrace = effectiveGracePeriod(PREFERRED_REVIEW_GRACE_PERIOD_MS, score, lastCompleted);
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

    it('combined bad reputation + just reviewed = very long grace period', async () => {
      const events = makeReputationEvents('very-bad-recent', 5, 50);
      for (const e of events) {
        await store.recordReputationEvent(e);
      }

      // Recent completed claim (2 min ago)
      await store.createTask(makeTask({ id: 'old-task-2', status: 'completed' }));
      await store.createClaim({
        id: 'old-task-2:very-bad-recent:review',
        task_id: 'old-task-2',
        agent_id: 'very-bad-recent',
        role: 'review',
        status: 'completed',
        created_at: Date.now() - 2 * 60_000,
      });

      const repEvents = await store.getAgentReputationEvents(
        'very-bad-recent',
        REPUTATION_SCORE_WINDOW_MS,
      );
      const score = computeAgentReputation(repEvents);
      const lastCompleted = await store.getAgentLastCompletedClaimAt('very-bad-recent');
      const effGrace = effectiveGracePeriod(PREFERRED_REVIEW_GRACE_PERIOD_MS, score, lastCompleted);

      // Bad score (~0.06 → ~6.5x) * cooldown (2.0) → ~13x base → ~390s
      expect(effGrace).toBeGreaterThan(300_000); // > 5 minutes
    });
  });

  describe('grace period — target_model tasks', () => {
    it('reputation multiplier applies to target_model grace period', async () => {
      // Proven good agent
      const events = makeReputationEvents('good-agent-tm', 50, 5);
      for (const e of events) {
        await store.recordReputationEvent(e);
      }

      const repEvents = await store.getAgentReputationEvents(
        'good-agent-tm',
        REPUTATION_SCORE_WINDOW_MS,
      );
      const score = computeAgentReputation(repEvents);
      const effGrace = effectiveGracePeriod(TARGET_MODEL_GRACE_PERIOD_MS, score, null);
      // 120s * 0.5 = 60s
      expect(effGrace).toBeLessThan(TARGET_MODEL_GRACE_PERIOD_MS);

      // Task with target_model that doesn't match, created 90s ago
      // Past effective grace (60s) but within default (120s)
      await store.createTask(
        makeTask({
          id: 'impl-1',
          task_type: 'implement',
          target_model: 'gpt-5.4',
          created_at: Date.now() - 90_000,
        }),
      );

      resetRateLimits();
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'good-agent-tm',
        model: 'claude-4',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tasks: unknown[] };
      // Good agent sees it earlier due to reputation boost
      expect(body.tasks).toHaveLength(1);
    });
  });

  describe('grace period — summary tasks', () => {
    it('reputation multiplier applies to summary grace period', async () => {
      // Proven good agent
      const events = makeReputationEvents('good-synth', 50, 5);
      for (const e of events) {
        await store.recordReputationEvent(e);
      }

      const repEvents = await store.getAgentReputationEvents(
        'good-synth',
        REPUTATION_SCORE_WINDOW_MS,
      );
      const score = computeAgentReputation(repEvents);
      const effGrace = effectiveGracePeriod(PREFERRED_SYNTH_GRACE_PERIOD_MS, score, null);
      // 60s * 0.5 = 30s
      expect(effGrace).toBeLessThan(PREFERRED_SYNTH_GRACE_PERIOD_MS);

      // Summary task with preferred synthesizer that doesn't match, created 45s ago
      await store.createTask(
        makeTask({
          id: 'summary-1',
          task_type: 'summary',
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            summarizer: {
              ...DEFAULT_REVIEW_CONFIG.summarizer,
              preferred: [{ agent: 'other-agent' }],
            },
          },
          reviews_completed_at: Date.now() - 45_000,
          created_at: Date.now() - 120_000,
        }),
      );

      resetRateLimits();
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'good-synth',
        model: 'claude-4',
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tasks: unknown[] };
      // Good agent sees summary earlier (effective grace 30s < 45s elapsed)
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
