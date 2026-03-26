import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { DEFAULT_REVIEW_CONFIG, type ReviewTask } from '@opencara/shared';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import {
  resetTimeoutThrottle,
  PREFERRED_SYNTH_GRACE_PERIOD_MS,
  PREFERRED_REVIEW_GRACE_PERIOD_MS,
  TIMEOUT_CHECK_INTERVAL_MS,
} from '../routes/tasks.js';
import { resetRateLimits } from '../middleware/rate-limit.js';

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
    queue: 'summary', // review_count=1 → summary queue
    github_installation_id: 123,
    private: false,
    config: DEFAULT_REVIEW_CONFIG,
    created_at: Date.now(),
    ...overrides,
  };
}

const mockEnv = {
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: 'test-key',
  WEB_URL: 'https://test.com',
};

describe('Task Routes', () => {
  let store: MemoryDataStore;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    resetTimeoutThrottle();
    resetRateLimits();
    store = new MemoryDataStore();
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

    it('does not return tasks already claimed by agent', async () => {
      // Create task and claim it
      await store.createTask(makeTask());
      await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'summary',
      });

      // Task should now be in finished queue — not visible
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(0);
    });

    it('skips summary tasks where agent has a pending summary claim', async () => {
      // Simulate claim-release cycle: task back in summary queue, agent already has a claim
      await store.createTask(makeTask({ queue: 'summary' }));
      await store.createClaim({
        id: 'task-1:agent-1:summary',
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

    it('skips summary tasks where agent has a completed summary claim', async () => {
      await store.createTask(makeTask({ queue: 'summary' }));
      await store.createClaim({
        id: 'task-1:agent-1:summary',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'summary',
        status: 'completed',
        created_at: Date.now(),
      });

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(0);
    });

    it('returns summary tasks where agent has an error summary claim', async () => {
      // Agents with terminal error claims should be able to re-claim
      await store.createTask(makeTask({ queue: 'summary' }));
      await store.createClaim({
        id: 'task-1:agent-1:summary',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'summary',
        status: 'error',
        created_at: Date.now(),
      });

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].role).toBe('summary');
    });

    it('returns summary tasks where agent has a rejected summary claim', async () => {
      await store.createTask(makeTask({ queue: 'summary' }));
      await store.createClaim({
        id: 'task-1:agent-1:summary',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'summary',
        status: 'rejected',
        created_at: Date.now(),
      });

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].role).toBe('summary');
    });

    it('does not return timed-out tasks', async () => {
      await store.createTask(makeTask({ timeout_at: Date.now() - 1000 }));
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(0);
    });

    it('returns review role for multi-agent tasks', async () => {
      await store.createTask(makeTask({ review_count: 3, queue: 'review' }));
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks[0].role).toBe('review');
    });

    it('returns 400 when agent_id is missing', async () => {
      const res = await request('POST', '/api/tasks/poll', {});
      expect(res.status).toBe(400);
    });

    it('skips summary tasks when review_only is true', async () => {
      // review_count=1 → summary queue
      await store.createTask(makeTask());
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        review_only: true,
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(0);
    });

    it('returns review tasks when review_only is true', async () => {
      // review_count=3 → review queue
      await store.createTask(makeTask({ review_count: 3, queue: 'review' }));
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        review_only: true,
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].role).toBe('review');
    });

    it('returns both review and summary when review_only is not set', async () => {
      await store.createTask(makeTask({ id: 'task-review', review_count: 3, queue: 'review' }));
      await store.createTask(makeTask({ id: 'task-summary', review_count: 1, queue: 'summary' }));
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(2);
      const roles = body.tasks.map((t: { role: string }) => t.role).sort();
      expect(roles).toEqual(['review', 'summary']);
    });

    it('returns summary tasks when review_only is false', async () => {
      await store.createTask(makeTask());
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        review_only: false,
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].role).toBe('summary');
    });

    // ── Private repo filtering ────────────────────────────

    it('hides private repo tasks from agents without matching repos', async () => {
      await store.createTask(makeTask({ private: true }));
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(0);
    });

    it('returns private repo tasks to agents with matching repos', async () => {
      await store.createTask(makeTask({ private: true }));
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        repos: ['test-org/test-repo'],
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].task_id).toBe('task-1');
    });

    it('hides private repo tasks when agent repos do not match', async () => {
      await store.createTask(makeTask({ private: true }));
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        repos: ['other-org/other-repo'],
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(0);
    });

    it('returns public tasks to all agents regardless of repos', async () => {
      await store.createTask(makeTask({ private: false }));
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
    });

    it('returns public tasks plus matching private tasks', async () => {
      await store.createTask(makeTask({ id: 'public-task', private: false }));
      await store.createTask(
        makeTask({ id: 'private-match', private: true, owner: 'priv-org', repo: 'priv-repo' }),
      );
      await store.createTask(
        makeTask({ id: 'private-no-match', private: true, owner: 'secret-org', repo: 'secret' }),
      );
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        repos: ['priv-org/priv-repo'],
      });
      const body = await res.json();
      const ids = body.tasks.map((t: { task_id: string }) => t.task_id).sort();
      expect(ids).toEqual(['private-match', 'public-task']);
    });

    // ── Roles filtering ────────────────────────────────────

    it('filters tasks by roles — review only', async () => {
      await store.createTask(makeTask({ id: 'summary-task', review_count: 1, queue: 'summary' }));
      await store.createTask(makeTask({ id: 'review-task', review_count: 3, queue: 'review' }));
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        roles: ['review'],
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].task_id).toBe('review-task');
      expect(body.tasks[0].role).toBe('review');
    });

    it('filters tasks by roles — summary only', async () => {
      await store.createTask(makeTask({ id: 'summary-task', review_count: 1, queue: 'summary' }));
      await store.createTask(makeTask({ id: 'review-task', review_count: 3, queue: 'review' }));
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        roles: ['summary'],
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].task_id).toBe('summary-task');
      expect(body.tasks[0].role).toBe('summary');
    });

    it('returns both roles when roles includes both', async () => {
      await store.createTask(makeTask({ id: 'summary-task', review_count: 1, queue: 'summary' }));
      await store.createTask(makeTask({ id: 'review-task', review_count: 3, queue: 'review' }));
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        roles: ['review', 'summary'],
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(2);
    });

    it('returns all tasks when roles is omitted (backward compatible)', async () => {
      await store.createTask(makeTask({ id: 'summary-task', review_count: 1, queue: 'summary' }));
      await store.createTask(makeTask({ id: 'review-task', review_count: 3, queue: 'review' }));
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(2);
    });

    it('roles takes precedence over review_only', async () => {
      await store.createTask(makeTask({ id: 'summary-task', review_count: 1, queue: 'summary' }));
      await store.createTask(makeTask({ id: 'review-task', review_count: 3, queue: 'review' }));
      // roles says summary, review_only says true — roles wins
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        roles: ['summary'],
        review_only: true,
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].role).toBe('summary');
    });

    // ── synthesize_repos filtering ─────────────────────────

    it('filters summary tasks by synthesize_repos whitelist', async () => {
      await store.createTask(
        makeTask({ id: 'task-a', review_count: 1, queue: 'summary', owner: 'org', repo: 'repo-a' }),
      );
      await store.createTask(
        makeTask({ id: 'task-b', review_count: 1, queue: 'summary', owner: 'org', repo: 'repo-b' }),
      );
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        synthesize_repos: { mode: 'whitelist', list: ['org/repo-a'] },
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].task_id).toBe('task-a');
    });

    it('does not filter review tasks by synthesize_repos', async () => {
      await store.createTask(
        makeTask({
          id: 'review-task',
          review_count: 3,
          queue: 'review',
          owner: 'org',
          repo: 'repo-x',
        }),
      );
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        synthesize_repos: { mode: 'whitelist', list: ['org/repo-other'] },
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].role).toBe('review');
    });

    it('returns all summary tasks when synthesize_repos is omitted', async () => {
      await store.createTask(
        makeTask({ id: 'task-a', review_count: 1, queue: 'summary', owner: 'org', repo: 'repo-a' }),
      );
      await store.createTask(
        makeTask({ id: 'task-b', review_count: 1, queue: 'summary', owner: 'org', repo: 'repo-b' }),
      );
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(2);
    });

    // ── eligibility in poll (github_username removed — identity from OAuth) ──

    it('filters tasks by agent eligibility during poll', async () => {
      const config = {
        ...DEFAULT_REVIEW_CONFIG,
        reviewer: {
          ...DEFAULT_REVIEW_CONFIG.reviewer,
          whitelist: [{ agent: 'agent-allowed' }],
        },
      };
      await store.createTask(makeTask({ config, queue: 'review', review_count: 2 }));
      // Non-whitelisted agent — not eligible
      const res1 = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body1 = await res1.json();
      expect(body1.tasks).toHaveLength(0);
      // Whitelisted agent — eligible
      const res2 = await request('POST', '/api/tasks/poll', { agent_id: 'agent-allowed' });
      const body2 = await res2.json();
      expect(body2.tasks).toHaveLength(1);
    });
  });

  // ── Rate Limiting ────────────────────────────────────────

  describe('rate limiting', () => {
    it('returns 429 when poll rate limit exceeded', async () => {
      // POLL_RATE_LIMIT is 12 requests per 60s
      for (let i = 0; i < 12; i++) {
        const res = await request('POST', '/api/tasks/poll', { agent_id: 'spam-agent' });
        expect(res.status).toBe(200);
      }
      // 13th request should be rate limited
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'spam-agent' });
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(body.error.message).toBe('Rate limit exceeded');
      expect(res.headers.get('Retry-After')).toBeDefined();
    });

    it('does not rate limit different agents', async () => {
      for (let i = 0; i < 12; i++) {
        await request('POST', '/api/tasks/poll', { agent_id: 'agent-a' });
      }
      // agent-b should still be allowed
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-b' });
      expect(res.status).toBe(200);
    });

    it('allows requests without agent_id to pass through to handler', async () => {
      // Without agent_id, the rate limiter skips (lets handler return 400)
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
      expect(res.status).toBe(404);
      const body = await res.json();
      expect(body.error.code).toBe('TASK_NOT_FOUND');
    });

    it('rejects claim with wrong role', async () => {
      await store.createTask(makeTask()); // review_count=1, queue=summary → only summary
      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'review',
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('CLAIM_CONFLICT');
    });

    it('rejects double claim from same agent', async () => {
      await store.createTask(makeTask({ review_count: 3, queue: 'review' }));
      // First claim succeeds
      await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'review',
      });
      // Second claim fails (same agent, same role)
      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'review',
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('CLAIM_CONFLICT');
    });

    it('includes reviews when claiming summary role', async () => {
      await store.createTask(
        makeTask({
          review_count: 2,
          queue: 'summary',
          review_claims: 1,
          completed_reviews: 1,
        }),
      );
      // Add a completed review with model/tool/thinking
      await store.createClaim({
        id: 'task-1:reviewer:review',
        task_id: 'task-1',
        agent_id: 'reviewer',
        role: 'review',
        status: 'completed',
        review_text: 'LGTM - looks good to me',
        verdict: 'approve',
        model: 'claude-sonnet-4-6',
        tool: 'claude',
        thinking: '10000',
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
      expect(body.reviews[0].review_text).toBe('LGTM - looks good to me');
      expect(body.reviews[0].model).toBe('claude-sonnet-4-6');
      expect(body.reviews[0].tool).toBe('claude');
      expect(body.reviews[0].thinking).toBe('10000');
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

    it('moves task to finished queue on summary claim', async () => {
      await store.createTask(makeTask());
      await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'summary',
      });
      const task = await store.getTask('task-1');
      expect(task?.queue).toBe('finished');
      expect(task?.summary_agent_id).toBe('agent-1');
    });

    it('reviewer can claim summary after completing review (#330)', async () => {
      // Start with review_count=2, review queue
      await store.createTask(makeTask({ review_count: 2, queue: 'review' }));

      // Agent-a claims review
      await request('POST', '/api/tasks/task-1/claim', { agent_id: 'agent-a', role: 'review' });

      // Agent-a submits review — this should move task to summary queue
      await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-a',
        type: 'review',
        review_text: 'Review A: Detailed analysis',
        verdict: 'approve',
      });

      // Task should now be in summary queue
      const task = await store.getTask('task-1');
      expect(task?.queue).toBe('summary');

      // Agent-a should be able to claim summary (role-aware claim ID)
      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-a',
        role: 'summary',
      });
      const body = await res.json();
      expect(body.claimed).toBe(true);
    });

    it('filters claim by agent eligibility (agent-based whitelist)', async () => {
      const config = {
        ...DEFAULT_REVIEW_CONFIG,
        summarizer: {
          whitelist: [{ agent: 'agent-allowed' }],
          blacklist: [],
          preferred: [],
        },
      };
      await store.createTask(makeTask({ config }));
      // Non-whitelisted agent — rejected
      const res1 = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'summary',
      });
      expect(res1.status).toBe(409);
      // Whitelisted agent — allowed
      const res2 = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-allowed',
        role: 'summary',
      });
      const body2 = await res2.json();
      expect(body2.claimed).toBe(true);
    });

    it('rejects claim when agent is blacklisted', async () => {
      const config = {
        ...DEFAULT_REVIEW_CONFIG,
        summarizer: {
          ...DEFAULT_REVIEW_CONFIG.summarizer,
          blacklist: [{ agent: 'agent-blocked' }],
        },
      };
      await store.createTask(makeTask({ config }));
      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-blocked',
        role: 'summary',
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('CLAIM_CONFLICT');
    });

    it('prevents oversubscription with concurrent review claims', async () => {
      // Task with review_count=3 → 2 review slots (review_count - 1)
      await store.createTask(makeTask({ review_count: 3, queue: 'review', review_claims: 0 }));

      // Three agents race for 2 review slots
      const results = await Promise.all([
        request('POST', '/api/tasks/task-1/claim', { agent_id: 'agent-1', role: 'review' }),
        request('POST', '/api/tasks/task-1/claim', { agent_id: 'agent-2', role: 'review' }),
        request('POST', '/api/tasks/task-1/claim', { agent_id: 'agent-3', role: 'review' }),
      ]);

      const statuses = results.map((r) => r.status);
      const successes = statuses.filter((s) => s === 200);
      const conflicts = statuses.filter((s) => s === 409);

      // Exactly 2 should succeed, 1 should be rejected
      expect(successes).toHaveLength(2);
      expect(conflicts).toHaveLength(1);

      // Task should have exactly 2 review_claims
      const task = await store.getTask('task-1');
      expect(task?.review_claims).toBe(2);
    });

    it('review claim releases slot on duplicate agent claim', async () => {
      await store.createTask(makeTask({ review_count: 3, queue: 'review', review_claims: 0 }));

      // First claim succeeds
      const res1 = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'review',
      });
      expect(res1.status).toBe(200);

      // Same agent tries again — should fail and release the reserved slot
      const res2 = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'review',
      });
      expect(res2.status).toBe(409);

      // review_claims should still be 1 (slot was released after duplicate detection)
      const task = await store.getTask('task-1');
      expect(task?.review_claims).toBe(1);
    });

    it('handles concurrent duplicate claims without corrupting slot count', async () => {
      await store.createTask(makeTask({ review_count: 3, queue: 'review', review_claims: 0 }));

      // First claim succeeds
      await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'review',
      });

      // Fire multiple duplicate claims concurrently
      await Promise.all([
        request('POST', '/api/tasks/task-1/claim', {
          agent_id: 'agent-1',
          role: 'review',
        }),
        request('POST', '/api/tasks/task-1/claim', {
          agent_id: 'agent-1',
          role: 'review',
        }),
        request('POST', '/api/tasks/task-1/claim', {
          agent_id: 'agent-1',
          role: 'review',
        }),
      ]);

      // Slot count should still be 1 (only the original claim)
      const task = await store.getTask('task-1');
      expect(task?.review_claims).toBe(1);
    });
  });

  // ── Result ───────────────────────────────────────────────

  describe('POST /api/tasks/:taskId/result', () => {
    it('stores review result', async () => {
      await store.createTask(makeTask({ review_count: 3, queue: 'review' }));
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
        review_text: 'test review content',
      });
      expect(res.status).toBe(404);
    });

    it('rejects result when submission type does not match claim role (review claim, summary submission)', async () => {
      await store.createTask(makeTask({ review_count: 3, queue: 'review' }));
      await store.createClaim({
        id: 'task-1:agent-1:review',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'review',
        status: 'pending',
        created_at: Date.now(),
      });

      // Submitting 'summary' type looks for claim ID task-1:agent-1:summary which doesn't exist
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-1',
        type: 'summary',
        review_text: 'Synthesized review',
      });
      expect(res.status).toBe(404); // No summary claim exists
    });

    it('rejects result when submission type does not match claim role (summary claim, review submission)', async () => {
      await store.createTask(makeTask());
      await store.createClaim({
        id: 'task-1:agent-1:summary',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'summary',
        status: 'pending',
        created_at: Date.now(),
      });

      // Submitting 'review' type looks for claim ID task-1:agent-1:review which doesn't exist
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-1',
        type: 'review',
        review_text: 'Individual review',
      });
      expect(res.status).toBe(404); // No review claim exists
    });

    it('rejects result for already completed claim', async () => {
      await store.createTask(makeTask());
      await store.createClaim({
        id: 'task-1:agent-1:summary',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'summary',
        status: 'completed',
        created_at: Date.now(),
      });

      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-1',
        type: 'summary',
        review_text: 'test review content',
      });
      expect(res.status).toBe(409);
    });

    it('moves task to summary queue when last review is submitted', async () => {
      await store.createTask(makeTask({ review_count: 2, queue: 'review' }));
      // Agent claims review
      await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-a',
        role: 'review',
      });
      // Submit review
      await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-a',
        type: 'review',
        review_text: 'Looks good overall',
        verdict: 'approve',
      });

      const task = await store.getTask('task-1');
      expect(task?.queue).toBe('summary');
      expect(task?.completed_reviews).toBe(1);
    });
  });

  // ── Reject / Error ───────────────────────────────────────

  describe('POST /api/tasks/:taskId/reject', () => {
    it('marks claim as rejected', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          review_claims: 1,
          status: 'reviewing',
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-1:review',
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

    it('returns 404 for missing claim', async () => {
      const res = await request('POST', '/api/tasks/task-1/reject', {
        agent_id: 'nonexistent',
        reason: 'test',
      });
      expect(res.status).toBe(404);
    });

    it('returns 409 if claim is completed', async () => {
      await store.createClaim({
        id: 'task-1:agent-1:review',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'review',
        status: 'completed',
        created_at: Date.now(),
      });

      const res = await request('POST', '/api/tasks/task-1/reject', {
        agent_id: 'agent-1',
        reason: 'test',
      });
      expect(res.status).toBe(409);
    });

    it('is idempotent — double reject returns 200', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          review_claims: 1,
          status: 'reviewing',
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-1:review',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'review',
        status: 'pending',
        created_at: Date.now(),
      });

      // First reject
      const res1 = await request('POST', '/api/tasks/task-1/reject', {
        agent_id: 'agent-1',
        reason: 'test',
      });
      expect(res1.status).toBe(200);

      // Second reject — idempotent
      const res2 = await request('POST', '/api/tasks/task-1/reject', {
        agent_id: 'agent-1',
        reason: 'test again',
      });
      expect(res2.status).toBe(200);
    });

    it('frees review slot (review_claims decremented)', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          review_claims: 2,
          status: 'reviewing',
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-1:review',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'review',
        status: 'pending',
        created_at: Date.now(),
      });

      await request('POST', '/api/tasks/task-1/reject', {
        agent_id: 'agent-1',
        reason: 'Cannot access diff',
      });

      const task = await store.getTask('task-1');
      expect(task?.review_claims).toBe(1);
    });

    it('moves task back to summary queue on summary reject', async () => {
      await store.createTask(
        makeTask({
          queue: 'finished',
          summary_agent_id: 'agent-1',
          status: 'reviewing',
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-1:summary',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'summary',
        status: 'pending',
        created_at: Date.now(),
      });

      await request('POST', '/api/tasks/task-1/reject', {
        agent_id: 'agent-1',
        reason: 'test',
      });

      const task = await store.getTask('task-1');
      expect(task?.queue).toBe('summary');
      expect(task?.summary_agent_id).toBeUndefined();
    });

    it('counter underflow protection — reject when review_claims is already 0', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          review_claims: 0, // already 0 (edge case)
          status: 'reviewing',
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-1:review',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'review',
        status: 'pending',
        created_at: Date.now(),
      });

      await request('POST', '/api/tasks/task-1/reject', {
        agent_id: 'agent-1',
        reason: 'test',
      });

      const task = await store.getTask('task-1');
      expect(task?.review_claims).toBe(0); // underflow protected by releaseReviewSlot
    });

    it('concurrent rejections decrement review_claims correctly', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          review_claims: 2,
          status: 'reviewing',
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-1:review',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'review',
        status: 'pending',
        created_at: Date.now(),
      });
      await store.createClaim({
        id: 'task-1:agent-2:review',
        task_id: 'task-1',
        agent_id: 'agent-2',
        role: 'review',
        status: 'pending',
        created_at: Date.now(),
      });

      // Both agents reject concurrently
      const [res1, res2] = await Promise.all([
        request('POST', '/api/tasks/task-1/reject', {
          agent_id: 'agent-1',
          reason: 'test',
        }),
        request('POST', '/api/tasks/task-1/reject', {
          agent_id: 'agent-2',
          reason: 'test',
        }),
      ]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const task = await store.getTask('task-1');
      expect(task?.review_claims).toBe(0); // both decrements applied atomically
    });
  });

  describe('POST /api/tasks/:taskId/error', () => {
    it('marks claim as error', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          review_claims: 1,
          status: 'reviewing',
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-1:review',
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

    it('returns 404 for missing claim', async () => {
      const res = await request('POST', '/api/tasks/task-1/error', {
        agent_id: 'nonexistent',
        error: 'test',
      });
      expect(res.status).toBe(404);
    });

    it('returns 409 if claim is completed', async () => {
      await store.createClaim({
        id: 'task-1:agent-1:review',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'review',
        status: 'completed',
        created_at: Date.now(),
      });

      const res = await request('POST', '/api/tasks/task-1/error', {
        agent_id: 'agent-1',
        error: 'test',
      });
      expect(res.status).toBe(409);
    });

    it('is idempotent — double error returns 200', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          review_claims: 1,
          status: 'reviewing',
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-1:review',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'review',
        status: 'pending',
        created_at: Date.now(),
      });

      await request('POST', '/api/tasks/task-1/error', { agent_id: 'agent-1', error: 'crash' });
      const res2 = await request('POST', '/api/tasks/task-1/error', {
        agent_id: 'agent-1',
        error: 'crash again',
      });
      expect(res2.status).toBe(200);
    });

    it('moves task back to summary queue on summary error', async () => {
      await store.createTask(
        makeTask({
          queue: 'finished',
          summary_agent_id: 'agent-1',
          status: 'reviewing',
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-1:summary',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'summary',
        status: 'pending',
        created_at: Date.now(),
      });

      await request('POST', '/api/tasks/task-1/error', {
        agent_id: 'agent-1',
        error: 'crash',
      });

      const task = await store.getTask('task-1');
      expect(task?.queue).toBe('summary');
      expect(task?.summary_agent_id).toBeUndefined();
    });

    it('concurrent errors decrement review_claims correctly', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          review_claims: 2,
          status: 'reviewing',
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-1:review',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'review',
        status: 'pending',
        created_at: Date.now(),
      });
      await store.createClaim({
        id: 'task-1:agent-2:review',
        task_id: 'task-1',
        agent_id: 'agent-2',
        role: 'review',
        status: 'pending',
        created_at: Date.now(),
      });

      // Both agents report error concurrently
      const [res1, res2] = await Promise.all([
        request('POST', '/api/tasks/task-1/error', {
          agent_id: 'agent-1',
          error: 'crash',
        }),
        request('POST', '/api/tasks/task-1/error', {
          agent_id: 'agent-2',
          error: 'crash',
        }),
      ]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      const task = await store.getTask('task-1');
      expect(task?.review_claims).toBe(0); // both decrements applied atomically
    });
  });

  // ── Timeout throttle ────────────────────────────────────

  describe('checkTimeouts throttle', () => {
    it('skips checkTimeouts on consecutive polls within 30s', async () => {
      // Create an expired task — first poll will process it
      await store.createTask(makeTask({ id: 'task-a', timeout_at: Date.now() - 1000 }));

      // First poll — triggers checkTimeouts (task-a is deleted after timeout post)
      await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });

      // Create another expired task after the first poll
      await store.createTask(makeTask({ id: 'task-b', timeout_at: Date.now() - 1000 }));

      // Second poll within 30s — throttle skips checkTimeouts, so task-b stays pending
      await request('POST', '/api/tasks/poll', { agent_id: 'agent-2' });
      const taskB = await store.getTask('task-b');
      expect(taskB?.status).toBe('pending');
    });

    it('runs checkTimeouts after 30s gap', async () => {
      // First poll to set the throttle timestamp
      await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });

      // Create expired task
      await store.createTask(makeTask({ id: 'task-delayed', timeout_at: Date.now() - 1000 }));

      // Simulate passing the throttle interval by setting the stored timestamp past the threshold
      await store.setTimeoutLastCheck(Date.now() - TIMEOUT_CHECK_INTERVAL_MS - 1000);

      // Poll again — should now run checkTimeouts
      await request('POST', '/api/tasks/poll', { agent_id: 'agent-2' });

      // Task should be deleted after timeout post succeeded
      const task = await store.getTask('task-delayed');
      expect(task).toBeNull();
    });

    it('persists throttle timestamp in store, not module memory', async () => {
      // Poll to trigger checkTimeouts — this should store the timestamp
      await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });

      // Verify the timestamp was stored in the store
      const lastCheck = await store.getTimeoutLastCheck();
      expect(lastCheck).toBeGreaterThan(0);
      expect(lastCheck).toBeLessThanOrEqual(Date.now());
    });
  });

  // ── Structured error logging ────────────────────────────

  describe('structured error logging', () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    afterEach(() => {
      errorSpy.mockRestore();
    });

    it('reject endpoint logs structured error with agent ID', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          review_claims: 1,
          status: 'reviewing',
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-1:review',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'review',
        status: 'pending',
        created_at: Date.now(),
      });

      await request('POST', '/api/tasks/task-1/reject', {
        agent_id: 'agent-1',
        reason: 'Cannot access diff',
      });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"Agent rejected task"'));
      const logEntry = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(logEntry.agentId).toBe('agent-1');
      expect(logEntry.taskId).toBe('task-1');
      expect(logEntry.action).toBe('reject');
      expect(logEntry.role).toBe('review');
      expect(logEntry.reason).toBe('Cannot access diff');
    });

    it('error endpoint logs structured error with agent ID', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          review_claims: 1,
          status: 'reviewing',
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-1:review',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'review',
        status: 'pending',
        created_at: Date.now(),
      });

      await request('POST', '/api/tasks/task-1/error', {
        agent_id: 'agent-1',
        error: 'Tool crashed',
      });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"Agent reported error"'));
      const logEntry = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(logEntry.agentId).toBe('agent-1');
      expect(logEntry.taskId).toBe('task-1');
      expect(logEntry.action).toBe('error');
      expect(logEntry.role).toBe('review');
      expect(logEntry.error).toBe('Tool crashed');
    });

    it('result endpoint logs on no claim found', async () => {
      await store.createTask(makeTask());

      await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-unknown',
        type: 'review',
        review_text: 'test review content',
      });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"Result rejected'));
      const logEntry = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(logEntry.agentId).toBe('agent-unknown');
      expect(logEntry.taskId).toBe('task-1');
    });

    it('result endpoint logs on already-completed claim', async () => {
      await store.createTask(makeTask());
      await store.createClaim({
        id: 'task-1:agent-1:summary',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'summary',
        status: 'completed',
        created_at: Date.now(),
      });

      await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-1',
        type: 'summary',
        review_text: 'test review content',
      });

      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"Result rejected'));
      const logEntry = JSON.parse(errorSpy.mock.calls[0][0] as string);
      expect(logEntry.agentId).toBe('agent-1');
      expect(logEntry.claimStatus).toBe('completed');
    });
  });

  // ── Whitelist / Blacklist enforcement ────────────────────

  describe('whitelist/blacklist enforcement', () => {
    it('poll filters out tasks where agent is blacklisted for review', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            reviewer: {
              ...DEFAULT_REVIEW_CONFIG.reviewer,
              blacklist: [{ agent: 'agent-blocked' }],
            },
          },
        }),
      );

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-blocked' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(0);
    });

    it('poll returns tasks for non-blacklisted agents', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            reviewer: {
              ...DEFAULT_REVIEW_CONFIG.reviewer,
              blacklist: [{ agent: 'agent-blocked' }],
            },
          },
        }),
      );

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-allowed' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].role).toBe('review');
    });

    it('poll filters out tasks where agent is not in reviewer whitelist', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            reviewer: {
              ...DEFAULT_REVIEW_CONFIG.reviewer,
              whitelist: [{ agent: 'agent-trusted' }],
            },
          },
        }),
      );

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-untrusted' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(0);
    });

    it('poll returns tasks for whitelisted agents', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            reviewer: {
              ...DEFAULT_REVIEW_CONFIG.reviewer,
              whitelist: [{ agent: 'agent-trusted' }],
            },
          },
        }),
      );

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-trusted' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
    });

    it('poll enforces summarizer whitelist for summary role', async () => {
      await store.createTask(
        makeTask({
          review_count: 1,
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            summarizer: {
              whitelist: [{ agent: 'agent-synth' }],
              blacklist: [],
              preferred: [],
            },
          },
        }),
      );

      // Non-whitelisted agent sees no tasks
      const res1 = await request('POST', '/api/tasks/poll', { agent_id: 'agent-other' });
      const body1 = await res1.json();
      expect(body1.tasks).toHaveLength(0);

      // Whitelisted agent sees the task
      const res2 = await request('POST', '/api/tasks/poll', { agent_id: 'agent-synth' });
      const body2 = await res2.json();
      expect(body2.tasks).toHaveLength(1);
      expect(body2.tasks[0].role).toBe('summary');
    });

    it('claim rejects blacklisted agent with reason', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            reviewer: {
              ...DEFAULT_REVIEW_CONFIG.reviewer,
              blacklist: [{ agent: 'agent-blocked' }],
            },
          },
        }),
      );

      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-blocked',
        role: 'review',
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('CLAIM_CONFLICT');
      expect(body.error.message).toContain('blacklisted');
    });

    it('claim rejects non-whitelisted agent with reason', async () => {
      await store.createTask(
        makeTask({
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            summarizer: {
              whitelist: [{ agent: 'agent-synth' }],
              blacklist: [],
              preferred: [],
            },
          },
        }),
      );

      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-other',
        role: 'summary',
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('CLAIM_CONFLICT');
      expect(body.error.message).toContain('not in the summary whitelist');
    });

    it('default config (empty lists) allows all agents — backward compatible', async () => {
      await store.createTask(makeTask());

      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'any-agent',
        role: 'summary',
      });
      const body = await res.json();
      expect(body.claimed).toBe(true);
    });

    it('blacklist takes priority over whitelist in claim', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            reviewer: {
              ...DEFAULT_REVIEW_CONFIG.reviewer,
              whitelist: [{ agent: 'agent-both' }],
              blacklist: [{ agent: 'agent-both' }],
            },
          },
        }),
      );

      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-both',
        role: 'review',
      });
      expect(res.status).toBe(409);
      const body = await res.json();
      expect(body.error.code).toBe('CLAIM_CONFLICT');
      expect(body.error.message).toContain('blacklisted');
    });
  });

  // ── Summary queue — duplicate claim prevention ──────────

  describe('summary queue — duplicate claim prevention', () => {
    it('rejects summary claim when task is already in finished queue', async () => {
      await store.createTask(makeTask());

      // Agent A claims summary (moves task to finished queue)
      const res1 = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-a',
        role: 'summary',
      });
      expect((await res1.json()).claimed).toBe(true);

      // Agent B tries to claim summary — task is in finished queue, not summary
      const res2 = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-b',
        role: 'summary',
      });
      expect(res2.status).toBe(409);
    });

    it('allows summary claim after previous summary was rejected (task back in summary queue)', async () => {
      await store.createTask(makeTask());

      // Agent A claims and rejects summary
      await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-a',
        role: 'summary',
      });
      await request('POST', '/api/tasks/task-1/reject', {
        agent_id: 'agent-a',
        reason: 'test',
      });

      // Agent B should be able to claim summary (task is back in summary queue)
      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-b',
        role: 'summary',
      });
      const body = await res.json();
      expect(body.claimed).toBe(true);
    });

    it('allows summary claim after previous summary errored (task back in summary queue)', async () => {
      await store.createTask(makeTask());

      // Agent A claims and errors summary
      await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-a',
        role: 'summary',
      });
      await request('POST', '/api/tasks/task-1/error', {
        agent_id: 'agent-a',
        error: 'OOM',
      });

      // Agent B should be able to claim summary (task is back in summary queue)
      const res = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-b',
        role: 'summary',
      });
      const body = await res.json();
      expect(body.claimed).toBe(true);
    });
  });

  // ── Multi-agent flow ─────────────────────────────────────

  describe('multi-agent review flow', () => {
    it('review_count=3: 2 reviews → summary becomes available', async () => {
      await store.createTask(makeTask({ review_count: 3, queue: 'review' }));

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

      // Agent C polls → no tasks (review slots filled, reviews not done)
      res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-c' });
      body = await res.json();
      expect(body.tasks).toHaveLength(0);

      // Agent A submits review
      await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-a',
        type: 'review',
        review_text: 'Review A: Detailed analysis',
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
        review_text: 'Review B: Detailed analysis',
        verdict: 'comment',
      });

      // Now summary is available (task moved to summary queue)
      res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-c' });
      body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].role).toBe('summary');
    });

    it('review_count=1 goes directly to summary queue', async () => {
      await store.createTask(makeTask({ review_count: 1, queue: 'summary' }));

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-a' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].role).toBe('summary');
    });
  });

  // ── Preferred synthesizer (#216) ──────────────────────

  describe('preferred synthesizer (#216)', () => {
    function makePreferredConfig(preferred: Array<{ agent: string }>) {
      return {
        ...DEFAULT_REVIEW_CONFIG,
        summarizer: {
          ...DEFAULT_REVIEW_CONFIG.summarizer,
          preferred,
        },
      };
    }

    describe('review_count=1 (summary-only tasks)', () => {
      it('preferred agent gets summary immediately', async () => {
        await store.createTask(
          makeTask({
            config: makePreferredConfig([{ agent: 'agent-preferred' }]),
          }),
        );

        const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-preferred' });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].role).toBe('summary');
      });

      it('non-preferred agent is held during grace period', async () => {
        await store.createTask(
          makeTask({
            config: makePreferredConfig([{ agent: 'agent-preferred' }]),
            created_at: Date.now(), // just created
          }),
        );

        const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-other' });
        const body = await res.json();
        expect(body.tasks).toHaveLength(0);
      });

      it('non-preferred agent gets summary after grace period expires', async () => {
        await store.createTask(
          makeTask({
            config: makePreferredConfig([{ agent: 'agent-preferred' }]),
            created_at: Date.now() - PREFERRED_SYNTH_GRACE_PERIOD_MS - 1000,
          }),
        );

        const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-other' });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].role).toBe('summary');
      });
    });

    describe('multi-agent tasks (review_count > 1)', () => {
      it('preferred agent gets summary immediately when reviews are complete', async () => {
        await store.createTask(
          makeTask({
            review_count: 3,
            queue: 'summary',
            config: makePreferredConfig([{ agent: 'agent-preferred' }]),
            review_claims: 2,
            completed_reviews: 2,
            reviews_completed_at: Date.now(), // just completed
            status: 'reviewing',
          }),
        );

        const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-preferred' });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].role).toBe('summary');
      });

      it('non-preferred agent is held during grace period after reviews complete', async () => {
        await store.createTask(
          makeTask({
            review_count: 3,
            queue: 'summary',
            config: makePreferredConfig([{ agent: 'agent-preferred' }]),
            review_claims: 2,
            completed_reviews: 2,
            reviews_completed_at: Date.now(), // just completed
            status: 'reviewing',
          }),
        );

        const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-other' });
        const body = await res.json();
        expect(body.tasks).toHaveLength(0);
      });

      it('non-preferred agent gets summary after grace period expires', async () => {
        await store.createTask(
          makeTask({
            review_count: 3,
            queue: 'summary',
            config: makePreferredConfig([{ agent: 'agent-preferred' }]),
            review_claims: 2,
            completed_reviews: 2,
            reviews_completed_at: Date.now() - PREFERRED_SYNTH_GRACE_PERIOD_MS - 1000,
            status: 'reviewing',
          }),
        );

        const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-other' });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].role).toBe('summary');
      });

      it('non-preferred agent cannot claim summary during grace period', async () => {
        await store.createTask(
          makeTask({
            review_count: 3,
            queue: 'summary',
            config: makePreferredConfig([{ agent: 'agent-preferred' }]),
            review_claims: 2,
            completed_reviews: 2,
            reviews_completed_at: Date.now(), // just completed
            status: 'reviewing',
          }),
        );

        const res = await request('POST', '/api/tasks/task-1/claim', {
          agent_id: 'agent-other',
          role: 'summary',
        });
        expect(res.status).toBe(409);
        const body = await res.json();
        expect(body.error.code).toBe('CLAIM_CONFLICT');
      });

      it('preferred agent can claim summary during grace period', async () => {
        await store.createTask(
          makeTask({
            review_count: 3,
            queue: 'summary',
            config: makePreferredConfig([{ agent: 'agent-preferred' }]),
            review_claims: 2,
            completed_reviews: 2,
            reviews_completed_at: Date.now(), // just completed
            status: 'reviewing',
          }),
        );

        const res = await request('POST', '/api/tasks/task-1/claim', {
          agent_id: 'agent-preferred',
          role: 'summary',
        });
        const body = await res.json();
        expect(body.claimed).toBe(true);
      });
    });

    describe('no preference configured', () => {
      it('summary is available immediately when no preferred list', async () => {
        // DEFAULT_REVIEW_CONFIG has preferred: [] — current behavior unchanged
        await store.createTask(makeTask());

        const res = await request('POST', '/api/tasks/poll', { agent_id: 'any-agent' });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].role).toBe('summary');
      });
    });

    describe('reviews_completed_at is set when last review is submitted', () => {
      it('sets reviews_completed_at on final review submission', async () => {
        await store.createTask(makeTask({ review_count: 2, queue: 'review' }));

        // Claim review
        await request('POST', '/api/tasks/task-1/claim', {
          agent_id: 'agent-a',
          role: 'review',
        });

        // Submit review
        await request('POST', '/api/tasks/task-1/result', {
          agent_id: 'agent-a',
          type: 'review',
          review_text: 'Looks good overall',
          verdict: 'approve',
        });

        const task = await store.getTask('task-1');
        expect(task?.reviews_completed_at).toBeDefined();
        expect(task?.reviews_completed_at).toBeGreaterThan(0);
      });

      it('does not set reviews_completed_at before all reviews are done', async () => {
        await store.createTask(makeTask({ review_count: 3, queue: 'review' }));

        // Claim and submit first review
        await request('POST', '/api/tasks/task-1/claim', {
          agent_id: 'agent-a',
          role: 'review',
        });
        await request('POST', '/api/tasks/task-1/result', {
          agent_id: 'agent-a',
          type: 'review',
          review_text: 'Review A: Detailed analysis',
          verdict: 'approve',
        });

        const task = await store.getTask('task-1');
        expect(task?.reviews_completed_at).toBeUndefined();
      });
    });

    describe('multiple preferred agents (priority order)', () => {
      it('any preferred agent gets summary immediately', async () => {
        await store.createTask(
          makeTask({
            config: makePreferredConfig([
              { agent: 'agent-first-choice' },
              { agent: 'agent-second-choice' },
            ]),
          }),
        );

        // Second choice preferred agent also gets immediate access
        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-second-choice',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].role).toBe('summary');
      });
    });
  });

  // ── Preferred review models/tools (#355) ───────────────

  describe('preferred review models/tools (#355)', () => {
    function makePreferredReviewConfig(
      preferredModels: string[] = [],
      preferredTools: string[] = [],
    ) {
      return {
        ...DEFAULT_REVIEW_CONFIG,
        agents: {
          ...DEFAULT_REVIEW_CONFIG.agents,
          reviewCount: 3,
          preferredModels,
          preferredTools,
        },
      };
    }

    describe('grace period filtering', () => {
      it('preferred model agent sees review task immediately', async () => {
        await store.createTask(
          makeTask({
            review_count: 3,
            queue: 'review',
            config: makePreferredReviewConfig(['claude-sonnet-4-6'], []),
            created_at: Date.now(),
          }),
        );

        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-1',
          model: 'claude-sonnet-4-6',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].role).toBe('review');
      });

      it('preferred tool agent sees review task immediately', async () => {
        await store.createTask(
          makeTask({
            review_count: 3,
            queue: 'review',
            config: makePreferredReviewConfig([], ['claude']),
            created_at: Date.now(),
          }),
        );

        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-1',
          tool: 'claude',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].role).toBe('review');
      });

      it('non-preferred agent is held during grace period', async () => {
        await store.createTask(
          makeTask({
            review_count: 3,
            queue: 'review',
            config: makePreferredReviewConfig(['claude-sonnet-4-6'], []),
            created_at: Date.now(),
          }),
        );

        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-1',
          model: 'gemini-2.5-pro',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(0);
      });

      it('non-preferred agent sees review after grace period expires', async () => {
        await store.createTask(
          makeTask({
            review_count: 3,
            queue: 'review',
            config: makePreferredReviewConfig(['claude-sonnet-4-6'], []),
            created_at: Date.now() - PREFERRED_REVIEW_GRACE_PERIOD_MS - 1000,
          }),
        );

        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-1',
          model: 'gemini-2.5-pro',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].role).toBe('review');
      });

      it('agent with no model/tool is non-preferred during grace period', async () => {
        await store.createTask(
          makeTask({
            review_count: 3,
            queue: 'review',
            config: makePreferredReviewConfig(['claude-sonnet-4-6'], []),
            created_at: Date.now(),
          }),
        );

        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-1',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(0);
      });
    });

    describe('no preferences configured', () => {
      it('all agents see review tasks immediately when no preferred list', async () => {
        await store.createTask(
          makeTask({
            review_count: 3,
            queue: 'review',
            config: makePreferredReviewConfig([], []),
            created_at: Date.now(),
          }),
        );

        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-1',
          model: 'any-model',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].role).toBe('review');
      });
    });

    describe('sorting preferred first', () => {
      it('preferred tasks are sorted before non-preferred', async () => {
        // Task A: prefers gemini (not matching our agent)
        await store.createTask(
          makeTask({
            id: 'task-a',
            review_count: 3,
            queue: 'review',
            config: makePreferredReviewConfig(['gemini-2.5-pro'], []),
            created_at: Date.now() - PREFERRED_REVIEW_GRACE_PERIOD_MS - 1000,
          }),
        );

        // Task B: prefers claude-sonnet-4-6 (matching our agent)
        await store.createTask(
          makeTask({
            id: 'task-b',
            review_count: 3,
            queue: 'review',
            config: makePreferredReviewConfig(['claude-sonnet-4-6'], []),
            created_at: Date.now() - PREFERRED_REVIEW_GRACE_PERIOD_MS - 1000,
          }),
        );

        // Agent with claude-sonnet-4-6 — task-b (preferred) should be sorted before task-a
        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-1',
          model: 'claude-sonnet-4-6',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(2);
        expect(body.tasks[0].task_id).toBe('task-b');
        expect(body.tasks[1].task_id).toBe('task-a');
      });

      it('non-preferred agent sees preferred tasks sorted last', async () => {
        // Task A: no preferences (everyone is "preferred")
        await store.createTask(
          makeTask({
            id: 'task-a',
            review_count: 3,
            queue: 'review',
            config: makePreferredReviewConfig([], []),
            created_at: Date.now() - PREFERRED_REVIEW_GRACE_PERIOD_MS - 1000,
          }),
        );

        // Task B: prefers claude-sonnet-4-6
        await store.createTask(
          makeTask({
            id: 'task-b',
            review_count: 3,
            queue: 'review',
            config: makePreferredReviewConfig(['claude-sonnet-4-6'], []),
            created_at: Date.now() - PREFERRED_REVIEW_GRACE_PERIOD_MS - 1000,
          }),
        );

        // Agent with gemini — task-a should be first (preferred for it),
        // task-b should be last (not preferred)
        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-1',
          model: 'gemini-2.5-pro',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(2);
        expect(body.tasks[0].task_id).toBe('task-a');
        expect(body.tasks[1].task_id).toBe('task-b');
      });
    });

    describe('model and tool combined matching', () => {
      it('matches on tool when model does not match', async () => {
        await store.createTask(
          makeTask({
            review_count: 3,
            queue: 'review',
            config: makePreferredReviewConfig(['claude-sonnet-4-6'], ['gemini']),
            created_at: Date.now(),
          }),
        );

        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-1',
          model: 'gemini-2.5-pro',
          tool: 'gemini',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
      });
    });
  });

  // ── Summary claim timeout recovery (#462) ──────────────────

  describe('summary claim timeout recovery (#462)', () => {
    it('task returns to summary queue after summary claim is reclaimed', async () => {
      const now = Date.now();
      // Task in summary queue, agent-A claims it
      await store.createTask(makeTask({ queue: 'summary' }));
      const claimRes = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-A',
        role: 'summary',
      });
      expect(claimRes.status).toBe(200);

      // Verify task moved to finished queue
      let task = await store.getTask('task-1');
      expect(task?.queue).toBe('finished');
      expect(task?.summary_agent_id).toBe('agent-A');

      // Simulate agent going stale (heartbeat expired)
      await store.setAgentLastSeen('agent-A', now - 300_000);

      // Reclaim abandoned claims — should free the summary claim AND release the slot
      const freed = await store.reclaimAbandonedClaims(180_000);
      expect(freed).toBe(1);

      // Task should be back in summary queue
      task = await store.getTask('task-1');
      expect(task?.queue).toBe('summary');
      expect(task?.summary_agent_id).toBeUndefined();

      // Another agent should see it in poll
      const pollRes = await request('POST', '/api/tasks/poll', { agent_id: 'agent-B' });
      const pollBody = await pollRes.json();
      expect(pollBody.tasks).toHaveLength(1);
      expect(pollBody.tasks[0].role).toBe('summary');
    });

    it('another agent can claim summary after previous claim was reclaimed', async () => {
      const now = Date.now();
      await store.createTask(makeTask({ queue: 'summary' }));

      // Agent-A claims summary
      await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-A',
        role: 'summary',
      });

      // Agent-A goes stale, claim is reclaimed
      await store.setAgentLastSeen('agent-A', now - 300_000);
      await store.reclaimAbandonedClaims(180_000);

      // Agent-B can now claim the summary
      const claimRes = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-B',
        role: 'summary',
      });
      expect(claimRes.status).toBe(200);
      const body = await claimRes.json();
      expect(body.claimed).toBe(true);

      // Task should be in finished queue with agent-B
      const task = await store.getTask('task-1');
      expect(task?.queue).toBe('finished');
      expect(task?.summary_agent_id).toBe('agent-B');
    });

    it('original agent gets 409 when submitting result after claim was reclaimed', async () => {
      const now = Date.now();
      await store.createTask(makeTask({ queue: 'summary' }));

      // Agent-A claims summary
      await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-A',
        role: 'summary',
      });

      // Agent-A goes stale, claim is reclaimed
      await store.setAgentLastSeen('agent-A', now - 300_000);
      await store.reclaimAbandonedClaims(180_000);

      // Agent-A tries to submit result — should fail
      const resultRes = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-A',
        type: 'summary',
        review_text: 'This is a synthesized review of the changes. '.repeat(10),
        verdict: 'approve',
      });
      expect(resultRes.status).toBe(409);
      const body = await resultRes.json();
      expect(body.error.message).toContain('Claim already error');
    });
  });
});
