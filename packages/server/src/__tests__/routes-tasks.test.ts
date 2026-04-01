import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { stubOAuthFetch, OAUTH_HEADERS } from './test-oauth-helper.js';
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
    queue: 'summary', // deprecated — use task_type instead
    github_installation_id: 123,
    private: false,
    config: DEFAULT_REVIEW_CONFIG,
    created_at: Date.now(),
    // Default: summary task (review_count=1 → single agent = summary)
    task_type: 'summary',
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

describe('Task Routes', () => {
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

    it('includes diff_size in poll response when set on task', async () => {
      await store.createTask(makeTask({ diff_size: 250 }));
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].diff_size).toBe(250);
    });

    it('omits diff_size in poll response when not set on task', async () => {
      await store.createTask(makeTask());
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].diff_size).toBeUndefined();
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
      await store.createTask(makeTask({ review_count: 3, queue: 'review', task_type: 'review' }));
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
      await store.createTask(makeTask({ review_count: 3, queue: 'review', task_type: 'review' }));
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        review_only: true,
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].role).toBe('review');
    });

    it('returns both review and summary when review_only is not set', async () => {
      await store.createTask(
        makeTask({ id: 'task-review', review_count: 3, queue: 'review', task_type: 'review' }),
      );
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
      await store.createTask(
        makeTask({ id: 'review-task', review_count: 3, queue: 'review', task_type: 'review' }),
      );
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
      await store.createTask(
        makeTask({ id: 'review-task', review_count: 3, queue: 'review', task_type: 'review' }),
      );
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
      await store.createTask(
        makeTask({ id: 'review-task', review_count: 3, queue: 'review', task_type: 'review' }),
      );
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        roles: ['review', 'summary'],
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(2);
    });

    it('returns all tasks when roles is omitted (backward compatible)', async () => {
      await store.createTask(makeTask({ id: 'summary-task', review_count: 1, queue: 'summary' }));
      await store.createTask(
        makeTask({ id: 'review-task', review_count: 3, queue: 'review', task_type: 'review' }),
      );
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(2);
    });

    it('roles takes precedence over review_only', async () => {
      await store.createTask(makeTask({ id: 'summary-task', review_count: 1, queue: 'summary' }));
      await store.createTask(
        makeTask({ id: 'review-task', review_count: 3, queue: 'review', task_type: 'review' }),
      );
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
          task_type: 'review',
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
      await store.createTask(
        makeTask({ config, queue: 'review', review_count: 2, task_type: 'review' }),
      );
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

  // ── Dedup serialization ──────────────────────────────────

  describe('dedup serialization', () => {
    it('returns only the oldest pending dedup task per repo', async () => {
      const now = Date.now();
      await store.createTask(
        makeTask({
          id: 'dedup-old',
          task_type: 'pr_dedup',
          feature: 'dedup_pr',
          group_id: 'grp-old',
          created_at: now - 10_000,
        }),
      );
      await store.createTask(
        makeTask({
          id: 'dedup-new',
          task_type: 'pr_dedup',
          feature: 'dedup_pr',
          group_id: 'grp-new',
          created_at: now,
        }),
      );

      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        roles: ['pr_dedup'],
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].task_id).toBe('dedup-old');
    });

    it('returns no dedup task if one is already claimed for that repo', async () => {
      // Create a claimed (reviewing) dedup task
      await store.createTask(
        makeTask({
          id: 'dedup-claimed',
          task_type: 'pr_dedup',
          feature: 'dedup_pr',
          group_id: 'grp-claimed',
        }),
      );
      await request('POST', '/api/tasks/dedup-claimed/claim', {
        agent_id: 'agent-other',
        role: 'pr_dedup',
      });

      // Create a pending dedup task for the same repo
      await store.createTask(
        makeTask({
          id: 'dedup-pending',
          task_type: 'pr_dedup',
          feature: 'dedup_pr',
          group_id: 'grp-pending',
        }),
      );

      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        roles: ['pr_dedup'],
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(0);
    });

    it('does not serialize review/summary/triage tasks per repo', async () => {
      // Two review tasks for the same repo should both be returned
      await store.createTask(
        makeTask({
          id: 'review-1',
          task_type: 'review',
          feature: 'review',
          group_id: 'grp-r1',
        }),
      );
      await store.createTask(
        makeTask({
          id: 'review-2',
          task_type: 'review',
          feature: 'review',
          group_id: 'grp-r2',
        }),
      );

      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        roles: ['review'],
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(2);
    });

    it('does not block dedup tasks across different repos', async () => {
      const now = Date.now();
      await store.createTask(
        makeTask({
          id: 'dedup-repo-a',
          task_type: 'pr_dedup',
          feature: 'dedup_pr',
          group_id: 'grp-a',
          owner: 'org',
          repo: 'repo-a',
          created_at: now,
        }),
      );
      await store.createTask(
        makeTask({
          id: 'dedup-repo-b',
          task_type: 'pr_dedup',
          feature: 'dedup_pr',
          group_id: 'grp-b',
          owner: 'org',
          repo: 'repo-b',
          created_at: now,
        }),
      );

      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        roles: ['pr_dedup'],
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(2);
    });

    it('serializes issue_dedup tasks per repo the same as pr_dedup', async () => {
      const now = Date.now();
      await store.createTask(
        makeTask({
          id: 'issue-dedup-old',
          task_type: 'issue_dedup',
          feature: 'dedup_issue',
          group_id: 'grp-id-old',
          created_at: now - 5_000,
        }),
      );
      await store.createTask(
        makeTask({
          id: 'issue-dedup-new',
          task_type: 'issue_dedup',
          feature: 'dedup_issue',
          group_id: 'grp-id-new',
          created_at: now,
        }),
      );

      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        roles: ['issue_dedup'],
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].task_id).toBe('issue-dedup-old');
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
      await store.createTask(makeTask({ review_count: 3, queue: 'review', task_type: 'review' }));
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
      // Create a worker task with completed review in the same group
      await store.createTask(
        makeTask({
          id: 'worker-1',
          task_type: 'review',
          group_id: 'group-1',
          status: 'completed',
        }),
      );
      // Summary task in same group
      await store.createTask(makeTask({ id: 'task-1', task_type: 'summary', group_id: 'group-1' }));
      // Add a completed review on the worker task
      await store.createClaim({
        id: 'worker-1:reviewer:review',
        task_id: 'worker-1',
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

    it('moves task to reviewing on summary claim', async () => {
      await store.createTask(makeTask());
      await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'summary',
      });
      const task = await store.getTask('task-1');
      expect(task?.status).toBe('reviewing');
    });

    it('same agent can claim both worker and summary tasks in a group (#330)', async () => {
      // Worker task
      await store.createTask(makeTask({ id: 'w1', task_type: 'review', group_id: 'g1' }));
      // Summary task
      await store.createTask(makeTask({ id: 's1', task_type: 'summary', group_id: 'g1' }));

      // Agent-a claims and completes worker
      await request('POST', '/api/tasks/w1/claim', { agent_id: 'agent-a', role: 'review' });
      await request('POST', '/api/tasks/w1/result', {
        agent_id: 'agent-a',
        type: 'review',
        review_text: 'Review A: Detailed analysis of the code changes',
        verdict: 'approve',
      });

      // Agent-a can also claim the summary task
      const res = await request('POST', '/api/tasks/s1/claim', {
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

    it('prevents concurrent claims to the same task', async () => {
      // Each task in new model only accepts one claim (CAS: pending → reviewing)
      await store.createTask(makeTask({ id: 'task-1', task_type: 'review' }));

      // Three agents race for the same task
      const results = await Promise.all([
        request('POST', '/api/tasks/task-1/claim', { agent_id: 'agent-1', role: 'review' }),
        request('POST', '/api/tasks/task-1/claim', { agent_id: 'agent-2', role: 'review' }),
        request('POST', '/api/tasks/task-1/claim', { agent_id: 'agent-3', role: 'review' }),
      ]);

      const statuses = results.map((r) => r.status);
      const successes = statuses.filter((s) => s === 200);
      const conflicts = statuses.filter((s) => s === 409);

      // Exactly 1 should succeed, 2 should be rejected (CAS)
      expect(successes).toHaveLength(1);
      expect(conflicts).toHaveLength(2);
    });

    it('duplicate claim from same agent is rejected', async () => {
      await store.createTask(makeTask({ id: 'task-1', task_type: 'review' }));

      // First claim succeeds
      const res1 = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'review',
      });
      expect(res1.status).toBe(200);

      // Same agent tries again — task already in reviewing state
      const res2 = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'review',
      });
      expect(res2.status).toBe(409);
    });

    it('concurrent duplicate claims all rejected after first succeeds', async () => {
      await store.createTask(makeTask({ id: 'task-1', task_type: 'review' }));

      // First claim succeeds
      await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'review',
      });

      // Fire multiple duplicate claims concurrently — all should fail (task already reviewing)
      const results = await Promise.all([
        request('POST', '/api/tasks/task-1/claim', { agent_id: 'agent-1', role: 'review' }),
        request('POST', '/api/tasks/task-1/claim', { agent_id: 'agent-2', role: 'review' }),
        request('POST', '/api/tasks/task-1/claim', { agent_id: 'agent-3', role: 'review' }),
      ]);

      expect(results.every((r) => r.status === 409)).toBe(true);
    });

    it('updates agent heartbeat on successful claim', async () => {
      await store.createTask(makeTask());
      // Agent has no heartbeat yet
      const before = await store.getAgentLastSeen('agent-1');
      expect(before).toBeNull();

      await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-1',
        role: 'summary',
      });

      const after = await store.getAgentLastSeen('agent-1');
      expect(after).not.toBeNull();
      // Heartbeat should be recent (within last second)
      expect(Date.now() - after!).toBeLessThan(1000);
    });

    it('does not update heartbeat when claim fails validation', async () => {
      // Claim a nonexistent task — should not update heartbeat
      const res = await request('POST', '/api/tasks/nope/claim', {
        agent_id: 'agent-1',
        role: 'summary',
      });
      expect(res.status).toBe(404);

      const lastSeen = await store.getAgentLastSeen('agent-1');
      expect(lastSeen).toBeNull();
    });
  });

  // ── Result ───────────────────────────────────────────────

  describe('POST /api/tasks/:taskId/result', () => {
    it('stores review result', async () => {
      await store.createTask(makeTask({ task_type: 'review', status: 'reviewing' }));
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
      await store.createTask(makeTask({ review_count: 3, queue: 'review', task_type: 'review' }));
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

    it('creates summary task when last worker result is submitted', async () => {
      // Two worker tasks in the same group
      await store.createTask(
        makeTask({
          id: 'w1',
          review_count: 2,
          queue: 'review',
          task_type: 'review',
          group_id: 'grp-1',
        }),
      );
      await store.createTask(
        makeTask({
          id: 'w2',
          review_count: 2,
          queue: 'review',
          task_type: 'review',
          group_id: 'grp-1',
        }),
      );

      // Claim and submit both workers
      await request('POST', '/api/tasks/w1/claim', { agent_id: 'agent-a', role: 'review' });
      await request('POST', '/api/tasks/w1/result', {
        agent_id: 'agent-a',
        type: 'review',
        review_text: 'Review A: Detailed analysis',
        verdict: 'approve',
      });

      // After first worker, no summary yet
      const allTasks1 = await store.listTasks({});
      const summaries1 = allTasks1.filter((t) => t.task_type === 'summary');
      expect(summaries1).toHaveLength(0);

      await request('POST', '/api/tasks/w2/claim', { agent_id: 'agent-b', role: 'review' });
      await request('POST', '/api/tasks/w2/result', {
        agent_id: 'agent-b',
        type: 'review',
        review_text: 'Review B: Detailed analysis',
        verdict: 'comment',
      });

      // After second worker, summary task should exist
      const allTasks2 = await store.listTasks({});
      const summaries2 = allTasks2.filter(
        (t) => t.task_type === 'summary' && t.group_id === 'grp-1',
      );
      expect(summaries2).toHaveLength(1);
      expect(summaries2[0].status).toBe('pending');
    });

    it('updates agent heartbeat on successful result submission', async () => {
      await store.createTask(makeTask({ task_type: 'review', status: 'reviewing' }));
      await store.createClaim({
        id: 'task-1:agent-1:review',
        task_id: 'task-1',
        agent_id: 'agent-1',
        role: 'review',
        status: 'pending',
        created_at: Date.now(),
      });

      // Agent has no heartbeat yet
      const before = await store.getAgentLastSeen('agent-1');
      expect(before).toBeNull();

      await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-1',
        type: 'review',
        review_text: 'Looks good!',
        verdict: 'approve',
        tokens_used: 500,
      });

      const after = await store.getAgentLastSeen('agent-1');
      expect(after).not.toBeNull();
      // Heartbeat should be recent (within last second)
      expect(Date.now() - after!).toBeLessThan(1000);
    });

    it('does not update heartbeat when result has no matching claim', async () => {
      await store.createTask(makeTask());
      // Submit result without a claim — should not update heartbeat
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-unknown',
        type: 'review',
        review_text: 'test review content',
      });
      expect(res.status).toBe(404);

      const lastSeen = await store.getAgentLastSeen('agent-unknown');
      expect(lastSeen).toBeNull();
    });
  });

  // ── Reject / Error ───────────────────────────────────────

  describe('POST /api/tasks/:taskId/reject', () => {
    it('marks claim as rejected', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          task_type: 'review',
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
          task_type: 'review',
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

    it('releases task on reject (status back to pending)', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          task_type: 'review',
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
      expect(task?.status).toBe('pending');
    });

    it('releases summary task on reject (status back to pending)', async () => {
      await store.createTask(
        makeTask({
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
      expect(task?.status).toBe('pending');
    });

    it('counter underflow protection — reject when review_claims is already 0', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          task_type: 'review',
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

    it('concurrent rejections release separate tasks correctly', async () => {
      // Two separate worker tasks (new model: one task per agent)
      await store.createTask(
        makeTask({
          id: 'task-1',
          review_count: 3,
          queue: 'review',
          task_type: 'review',
          status: 'reviewing',
          group_id: 'grp-1',
        }),
      );
      await store.createTask(
        makeTask({
          id: 'task-2',
          review_count: 3,
          queue: 'review',
          task_type: 'review',
          status: 'reviewing',
          group_id: 'grp-1',
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
        id: 'task-2:agent-2:review',
        task_id: 'task-2',
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
        request('POST', '/api/tasks/task-2/reject', {
          agent_id: 'agent-2',
          reason: 'test',
        }),
      ]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // Both tasks released back to pending
      const t1 = await store.getTask('task-1');
      const t2 = await store.getTask('task-2');
      expect(t1?.status).toBe('pending');
      expect(t2?.status).toBe('pending');
    });
  });

  describe('POST /api/tasks/:taskId/error', () => {
    it('marks claim as error', async () => {
      await store.createTask(
        makeTask({
          review_count: 3,
          queue: 'review',
          task_type: 'review',
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
          task_type: 'review',
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

    it('releases summary task on error (status back to pending)', async () => {
      await store.createTask(
        makeTask({
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
      expect(task?.status).toBe('pending');
    });

    it('concurrent errors release separate tasks correctly', async () => {
      // Two separate worker tasks (new model: one task per agent)
      await store.createTask(
        makeTask({
          id: 'task-1',
          review_count: 3,
          queue: 'review',
          task_type: 'review',
          status: 'reviewing',
          group_id: 'grp-1',
        }),
      );
      await store.createTask(
        makeTask({
          id: 'task-2',
          review_count: 3,
          queue: 'review',
          task_type: 'review',
          status: 'reviewing',
          group_id: 'grp-1',
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
        id: 'task-2:agent-2:review',
        task_id: 'task-2',
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
        request('POST', '/api/tasks/task-2/error', {
          agent_id: 'agent-2',
          error: 'crash',
        }),
      ]);
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // Both tasks released back to pending
      const t1 = await store.getTask('task-1');
      const t2 = await store.getTask('task-2');
      expect(t1?.status).toBe('pending');
      expect(t2?.status).toBe('pending');
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
          task_type: 'review',
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
          task_type: 'review',
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
          task_type: 'review',
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
          task_type: 'review',
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
          task_type: 'review',
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
          task_type: 'review',
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
          task_type: 'review',
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
          task_type: 'review',
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
    it('review_count=3: 2 workers → summary becomes available after both complete', async () => {
      // Separate task model: 2 worker tasks in a group
      await store.createTask(
        makeTask({
          id: 'w1',
          review_count: 3,
          queue: 'review',
          task_type: 'review',
          group_id: 'grp-multi',
        }),
      );
      await store.createTask(
        makeTask({
          id: 'w2',
          review_count: 3,
          queue: 'review',
          task_type: 'review',
          group_id: 'grp-multi',
        }),
      );

      // Agent A polls → sees both worker tasks
      let res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-a' });
      let body = await res.json();
      expect(body.tasks.length).toBeGreaterThanOrEqual(1);
      expect(body.tasks[0].role).toBe('review');

      // Agent A claims first worker
      const claimRes = await request('POST', '/api/tasks/w1/claim', {
        agent_id: 'agent-a',
        role: 'review',
      });
      expect(claimRes.status).toBe(200);

      // Agent B claims second worker
      const claimRes2 = await request('POST', '/api/tasks/w2/claim', {
        agent_id: 'agent-b',
        role: 'review',
      });
      expect(claimRes2.status).toBe(200);

      // Agent C polls → no pending tasks (both claimed)
      res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-c' });
      body = await res.json();
      expect(body.tasks).toHaveLength(0);

      // Agent A submits review
      await request('POST', '/api/tasks/w1/result', {
        agent_id: 'agent-a',
        type: 'review',
        review_text: 'Review A: Detailed analysis',
        verdict: 'approve',
      });

      // Still no summary (only 1 of 2 workers done)
      res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-c' });
      body = await res.json();
      expect(body.tasks).toHaveLength(0);

      // Agent B submits review
      await request('POST', '/api/tasks/w2/result', {
        agent_id: 'agent-b',
        type: 'review',
        review_text: 'Review B: Detailed analysis',
        verdict: 'comment',
      });

      // Now summary is available (created when all workers completed)
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

      it('non-preferred agent gets summary after grace period expires (no reviews_completed_at)', async () => {
        // Single-agent task: falls back to created_at when reviews_completed_at is not set
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

      it('non-preferred agent gets summary after grace period expires (reviews_completed_at)', async () => {
        // Grace period based on reviews_completed_at, not created_at
        await store.createTask(
          makeTask({
            config: makePreferredConfig([{ agent: 'agent-preferred' }]),
            created_at: Date.now() - 300_000, // created 5 min ago (would expire old baseline)
            reviews_completed_at: Date.now() - PREFERRED_SYNTH_GRACE_PERIOD_MS - 1000,
          }),
        );

        const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-other' });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].role).toBe('summary');
      });

      it('non-preferred agent held when reviews_completed_at within grace period despite old created_at', async () => {
        // created_at is old but reviews_completed_at is recent — grace period still active
        await store.createTask(
          makeTask({
            config: makePreferredConfig([{ agent: 'agent-preferred' }]),
            created_at: Date.now() - 300_000, // created 5 min ago
            reviews_completed_at: Date.now(), // reviews just completed
          }),
        );

        const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-other' });
        const body = await res.json();
        expect(body.tasks).toHaveLength(0);
      });
    });

    describe('multi-agent tasks (review_count > 1)', () => {
      it('preferred agent gets summary immediately when reviews are complete', async () => {
        // Summary task created after workers complete — just created (grace period active)
        await store.createTask(
          makeTask({
            task_type: 'summary',
            queue: 'summary',
            config: makePreferredConfig([{ agent: 'agent-preferred' }]),
            created_at: Date.now(), // just created
            reviews_completed_at: Date.now(), // reviews just completed
          }),
        );

        const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-preferred' });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].role).toBe('summary');
      });

      it('non-preferred agent gets summary after grace period expires', async () => {
        await store.createTask(
          makeTask({
            task_type: 'summary',
            queue: 'summary',
            config: makePreferredConfig([{ agent: 'agent-preferred' }]),
            created_at: Date.now() - 300_000, // created 5 min ago
            reviews_completed_at: Date.now() - PREFERRED_SYNTH_GRACE_PERIOD_MS - 1000,
          }),
        );

        const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-other' });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].role).toBe('summary');
      });

      it('non-preferred agent held when reviews_completed_at within grace period', async () => {
        await store.createTask(
          makeTask({
            task_type: 'summary',
            queue: 'summary',
            config: makePreferredConfig([{ agent: 'agent-preferred' }]),
            created_at: Date.now() - 300_000, // created 5 min ago
            reviews_completed_at: Date.now(), // reviews just completed
          }),
        );

        const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-other' });
        const body = await res.json();
        expect(body.tasks).toHaveLength(0);
      });

      it('preferred agent can claim summary during grace period', async () => {
        await store.createTask(
          makeTask({
            task_type: 'summary',
            queue: 'summary',
            config: makePreferredConfig([{ agent: 'agent-preferred' }]),
            created_at: Date.now(),
            reviews_completed_at: Date.now(),
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

    describe('summary task creation tracks worker completion', () => {
      it('creates summary task when sole worker completes', async () => {
        // Single worker task in a group
        await store.createTask(
          makeTask({
            id: 'w1',
            review_count: 2,
            queue: 'review',
            task_type: 'review',
            group_id: 'grp-pref',
          }),
        );

        // Claim and submit
        await request('POST', '/api/tasks/w1/claim', { agent_id: 'agent-a', role: 'review' });
        await request('POST', '/api/tasks/w1/result', {
          agent_id: 'agent-a',
          type: 'review',
          review_text: 'Looks good overall',
          verdict: 'approve',
        });

        // Worker task should be completed
        const task = await store.getTask('w1');
        expect(task?.status).toBe('completed');

        // Summary task should have been created
        const allTasks = await store.listTasks({});
        const summaries = allTasks.filter(
          (t) => t.task_type === 'summary' && t.group_id === 'grp-pref',
        );
        expect(summaries).toHaveLength(1);
        expect(summaries[0].reviews_completed_at).toBeDefined();
        expect(summaries[0].reviews_completed_at).toBeGreaterThan(0);
      });

      it('summary task reviews_completed_at enables preferred model grace period', async () => {
        // Worker task with preferred_models config
        await store.createTask(
          makeTask({
            id: 'w-pref',
            review_count: 2,
            queue: 'review',
            task_type: 'review',
            group_id: 'grp-pref-grace',
            config: {
              ...DEFAULT_REVIEW_CONFIG,
              summarizer: {
                ...DEFAULT_REVIEW_CONFIG.summarizer,
                preferredModels: ['claude-opus-4-6'],
              },
            },
          }),
        );

        // Claim and submit worker result — this creates the summary task
        await request('POST', '/api/tasks/w-pref/claim', {
          agent_id: 'agent-a',
          role: 'review',
        });
        await request('POST', '/api/tasks/w-pref/result', {
          agent_id: 'agent-a',
          type: 'review',
          review_text: 'Review analysis',
          verdict: 'approve',
        });

        // Summary task should have reviews_completed_at set to ~now
        const allTasks = await store.listTasks({});
        const summaries = allTasks.filter(
          (t) => t.task_type === 'summary' && t.group_id === 'grp-pref-grace',
        );
        expect(summaries).toHaveLength(1);
        expect(summaries[0].reviews_completed_at).toBeDefined();

        // Non-preferred agent should NOT see summary during grace period
        // because reviews_completed_at was just set (grace period active)
        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-other',
          model: 'gpt-4o',
        });
        const body = await res.json();
        const summaryTasks = body.tasks.filter((t: { role: string }) => t.role === 'summary');
        expect(summaryTasks).toHaveLength(0);

        // Preferred agent SHOULD see summary during grace period (single poll)
        const prefRes = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-preferred',
          model: 'claude-opus-4-6',
        });
        const prefBody = await prefRes.json();
        const prefSummaryTasks = prefBody.tasks.filter(
          (t: { role: string }) => t.role === 'summary',
        );
        expect(prefSummaryTasks).toHaveLength(1);

        // Preferred agent SHOULD see summary via batch poll during grace period
        const batchRes = await request('POST', '/api/tasks/poll/batch', {
          agents: [
            { agent_name: 'Codex', roles: ['review', 'summary'], model: 'gpt-5.4', tool: 'codex' },
            {
              agent_name: 'Claude Opus',
              roles: ['review', 'summary'],
              model: 'claude-opus-4-6',
              tool: 'claude',
            },
          ],
        });
        const batchBody = await batchRes.json();
        const codexSummary = (batchBody.assignments['Codex']?.tasks ?? []).filter(
          (t: { role: string }) => t.role === 'summary',
        );
        const opusSummary = (batchBody.assignments['Claude Opus']?.tasks ?? []).filter(
          (t: { role: string }) => t.role === 'summary',
        );
        // Non-preferred Codex should NOT get summary during grace period
        expect(codexSummary).toHaveLength(0);
        // Preferred Claude Opus SHOULD get summary during grace period
        expect(opusSummary).toHaveLength(1);
      });

      it('preferred agent with private repo_filters sees summary via batch poll', async () => {
        // Summary task with preferred_models config
        await store.createTask(
          makeTask({
            id: 'summary-private',
            review_count: 1,
            queue: 'summary',
            task_type: 'summary',
            owner: 'OpenCara',
            repo: 'opencara-prod-test',
            config: {
              ...DEFAULT_REVIEW_CONFIG,
              summarizer: {
                ...DEFAULT_REVIEW_CONFIG.summarizer,
                preferredModels: ['claude-opus-4-6'],
              },
            },
          }),
        );

        // Batch poll with Claude Opus using private mode repo_filters
        const res = await request('POST', '/api/tasks/poll/batch', {
          agents: [
            {
              agent_name: 'Claude Opus',
              roles: ['review', 'summary'],
              model: 'claude-opus-4-6',
              tool: 'claude',
              repo_filters: [
                {
                  mode: 'private',
                  list: ['OpenCara/opencara-prod-test', 'OpenCara/OpenCara'],
                },
              ],
            },
          ],
        });
        const body = await res.json();
        const opusTasks = body.assignments['Claude Opus']?.tasks ?? [];
        const summaryTasks = opusTasks.filter((t: { role: string }) => t.role === 'summary');
        // Claude Opus with private mode should still see the summary
        expect(summaryTasks).toHaveLength(1);
      });

      it('does not create summary before all workers are done', async () => {
        // Two worker tasks in a group
        await store.createTask(
          makeTask({
            id: 'w1',
            review_count: 3,
            queue: 'review',
            task_type: 'review',
            group_id: 'grp-pref2',
          }),
        );
        await store.createTask(
          makeTask({
            id: 'w2',
            review_count: 3,
            queue: 'review',
            task_type: 'review',
            group_id: 'grp-pref2',
          }),
        );

        // Complete only first worker
        await request('POST', '/api/tasks/w1/claim', { agent_id: 'agent-a', role: 'review' });
        await request('POST', '/api/tasks/w1/result', {
          agent_id: 'agent-a',
          type: 'review',
          review_text: 'Review A: Detailed analysis',
          verdict: 'approve',
        });

        // No summary task yet
        const allTasks = await store.listTasks({});
        const summaries = allTasks.filter(
          (t) => t.task_type === 'summary' && t.group_id === 'grp-pref2',
        );
        expect(summaries).toHaveLength(0);
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

  // ── Preferred summarizer models (#555) ──────────────────

  describe('preferred summarizer models (#555)', () => {
    function makeModelPreferredConfig(preferredModels: string[]) {
      return {
        ...DEFAULT_REVIEW_CONFIG,
        summarizer: {
          ...DEFAULT_REVIEW_CONFIG.summarizer,
          preferredModels,
        },
      };
    }

    describe('poll — model preference during grace period', () => {
      it('agent with matching model gets summary immediately', async () => {
        await store.createTask(
          makeTask({
            config: makeModelPreferredConfig(['claude-opus-4-6', 'gpt-5.4']),
            created_at: Date.now(),
          }),
        );

        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-a',
          model: 'claude-opus-4-6',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].role).toBe('summary');
      });

      it('agent without matching model is held during grace period', async () => {
        await store.createTask(
          makeTask({
            config: makeModelPreferredConfig(['claude-opus-4-6']),
            created_at: Date.now(),
          }),
        );

        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-a',
          model: 'gpt-4o',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(0);
      });

      it('agent without model is held during grace period', async () => {
        await store.createTask(
          makeTask({
            config: makeModelPreferredConfig(['claude-opus-4-6']),
            created_at: Date.now(),
          }),
        );

        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-a',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(0);
      });

      it('non-matching agent gets summary after grace period expires (no reviews_completed_at)', async () => {
        // Falls back to created_at when reviews_completed_at is not set
        await store.createTask(
          makeTask({
            config: makeModelPreferredConfig(['claude-opus-4-6']),
            created_at: Date.now() - PREFERRED_SYNTH_GRACE_PERIOD_MS - 1000,
          }),
        );

        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-a',
          model: 'gpt-4o',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].role).toBe('summary');
      });

      it('non-matching agent gets summary after grace period expires (reviews_completed_at)', async () => {
        await store.createTask(
          makeTask({
            config: makeModelPreferredConfig(['claude-opus-4-6']),
            created_at: Date.now() - 300_000,
            reviews_completed_at: Date.now() - PREFERRED_SYNTH_GRACE_PERIOD_MS - 1000,
          }),
        );

        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-a',
          model: 'gpt-4o',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
        expect(body.tasks[0].role).toBe('summary');
      });

      it('non-matching agent held when reviews_completed_at within grace period despite old created_at', async () => {
        await store.createTask(
          makeTask({
            config: makeModelPreferredConfig(['claude-opus-4-6']),
            created_at: Date.now() - 300_000, // created 5 min ago
            reviews_completed_at: Date.now(), // reviews just completed
          }),
        );

        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-a',
          model: 'gpt-4o',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(0);
      });
    });

    describe('combined entity and model preferences', () => {
      it('entity-preferred agent gets summary even without matching model', async () => {
        await store.createTask(
          makeTask({
            config: {
              ...DEFAULT_REVIEW_CONFIG,
              summarizer: {
                ...DEFAULT_REVIEW_CONFIG.summarizer,
                preferred: [{ agent: 'agent-preferred' }],
                preferredModels: ['claude-opus-4-6'],
              },
            },
            created_at: Date.now(),
          }),
        );

        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-preferred',
          model: 'gpt-4o',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
      });

      it('model-preferred agent gets summary even without entity match', async () => {
        await store.createTask(
          makeTask({
            config: {
              ...DEFAULT_REVIEW_CONFIG,
              summarizer: {
                ...DEFAULT_REVIEW_CONFIG.summarizer,
                preferred: [{ agent: 'agent-preferred' }],
                preferredModels: ['claude-opus-4-6'],
              },
            },
            created_at: Date.now(),
          }),
        );

        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-other',
          model: 'claude-opus-4-6',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(1);
      });

      it('agent matching neither entity nor model is held during grace period', async () => {
        await store.createTask(
          makeTask({
            config: {
              ...DEFAULT_REVIEW_CONFIG,
              summarizer: {
                ...DEFAULT_REVIEW_CONFIG.summarizer,
                preferred: [{ agent: 'agent-preferred' }],
                preferredModels: ['claude-opus-4-6'],
              },
            },
            created_at: Date.now(),
          }),
        );

        const res = await request('POST', '/api/tasks/poll', {
          agent_id: 'agent-other',
          model: 'gpt-4o',
        });
        const body = await res.json();
        expect(body.tasks).toHaveLength(0);
      });
    });

    describe('claim — model preference during grace period', () => {
      it('model-preferred agent can claim summary during grace period', async () => {
        await store.createTask(
          makeTask({
            task_type: 'summary',
            queue: 'summary',
            config: makeModelPreferredConfig(['claude-opus-4-6']),
            created_at: Date.now(),
            reviews_completed_at: Date.now(),
          }),
        );

        const res = await request('POST', '/api/tasks/task-1/claim', {
          agent_id: 'agent-a',
          role: 'summary',
          model: 'claude-opus-4-6',
        });
        const body = await res.json();
        expect(body.claimed).toBe(true);
      });

      it('non-matching model agent cannot claim during grace period', async () => {
        await store.createTask(
          makeTask({
            task_type: 'summary',
            queue: 'summary',
            config: makeModelPreferredConfig(['claude-opus-4-6']),
            created_at: Date.now(),
            reviews_completed_at: Date.now(),
          }),
        );

        const res = await request('POST', '/api/tasks/task-1/claim', {
          agent_id: 'agent-a',
          role: 'summary',
          model: 'gpt-4o',
        });
        expect(res.status).toBe(409);
      });
    });

    describe('backward compatibility', () => {
      it('summary is available immediately when no preferredModels set', async () => {
        await store.createTask(makeTask());

        const res = await request('POST', '/api/tasks/poll', { agent_id: 'any-agent' });
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
        agentCount: 3,
        preferredModels,
        preferredTools,
      };
    }

    describe('grace period filtering', () => {
      it('preferred model agent sees review task immediately', async () => {
        await store.createTask(
          makeTask({
            review_count: 3,
            queue: 'review',
            task_type: 'review',
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
            task_type: 'review',
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
            task_type: 'review',
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
            task_type: 'review',
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
            task_type: 'review',
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
            task_type: 'review',
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
            task_type: 'review',
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
            task_type: 'review',
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
            task_type: 'review',
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
            task_type: 'review',
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
            task_type: 'review',
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

  // ── Model diversity grace period (#554) ─────────────────────

  describe('model diversity grace period (#554)', () => {
    function makeDiversityConfig(graceMs: number = 30_000) {
      return {
        ...DEFAULT_REVIEW_CONFIG,
        modelDiversityGraceMs: graceMs,
      };
    }

    it('hides task from agent whose model is already claimed in group during grace window', async () => {
      const config = makeDiversityConfig();
      // Task 1: already claimed by agent with gpt-5.4
      await store.createTask(
        makeTask({
          id: 'task-1',
          task_type: 'review',
          queue: 'review',
          group_id: 'group-div',
          status: 'reviewing',
          config,
          created_at: Date.now(),
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-A:review',
        task_id: 'task-1',
        agent_id: 'agent-A',
        role: 'review',
        status: 'pending',
        model: 'gpt-5.4',
        created_at: Date.now(),
      });

      // Task 2: pending, same group
      await store.createTask(
        makeTask({
          id: 'task-2',
          task_type: 'review',
          queue: 'review',
          group_id: 'group-div',
          status: 'pending',
          config,
          created_at: Date.now(),
        }),
      );

      // Agent with gpt-5.4 should NOT see task-2 during grace window
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-B',
        model: 'gpt-5.4',
      });
      const body = await res.json();
      expect(body.tasks.filter((t: { task_id: string }) => t.task_id === 'task-2')).toHaveLength(0);
    });

    it('shows task to agent with a different model during grace window', async () => {
      const config = makeDiversityConfig();
      // Task 1: claimed with gpt-5.4
      await store.createTask(
        makeTask({
          id: 'task-1',
          task_type: 'review',
          queue: 'review',
          group_id: 'group-div',
          status: 'reviewing',
          config,
          created_at: Date.now(),
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-A:review',
        task_id: 'task-1',
        agent_id: 'agent-A',
        role: 'review',
        status: 'pending',
        model: 'gpt-5.4',
        created_at: Date.now(),
      });

      // Task 2: pending, same group
      await store.createTask(
        makeTask({
          id: 'task-2',
          task_type: 'review',
          queue: 'review',
          group_id: 'group-div',
          status: 'pending',
          config,
          created_at: Date.now(),
        }),
      );

      // Agent with gemini — different model — should see task-2
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-B',
        model: 'gemini-2.5-pro',
      });
      const body = await res.json();
      expect(body.tasks.filter((t: { task_id: string }) => t.task_id === 'task-2')).toHaveLength(1);
    });

    it('shows task after grace period expires even if same model', async () => {
      const config = makeDiversityConfig(30_000);
      // Task 1: claimed with gpt-5.4
      await store.createTask(
        makeTask({
          id: 'task-1',
          task_type: 'review',
          queue: 'review',
          group_id: 'group-div',
          status: 'reviewing',
          config,
          created_at: Date.now() - 60_000,
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-A:review',
        task_id: 'task-1',
        agent_id: 'agent-A',
        role: 'review',
        status: 'pending',
        model: 'gpt-5.4',
        created_at: Date.now() - 60_000,
      });

      // Task 2: pending, same group, created 60s ago (> 30s grace)
      await store.createTask(
        makeTask({
          id: 'task-2',
          task_type: 'review',
          queue: 'review',
          group_id: 'group-div',
          status: 'pending',
          config,
          created_at: Date.now() - 60_000,
        }),
      );

      // Agent with gpt-5.4 should see task-2 after grace period
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-B',
        model: 'gpt-5.4',
      });
      const body = await res.json();
      expect(body.tasks.filter((t: { task_id: string }) => t.task_id === 'task-2')).toHaveLength(1);
    });

    it('diversity grace disabled (0) allows same model immediately', async () => {
      const config = makeDiversityConfig(0);
      // Task 1: claimed with gpt-5.4
      await store.createTask(
        makeTask({
          id: 'task-1',
          task_type: 'review',
          queue: 'review',
          group_id: 'group-div',
          status: 'reviewing',
          config,
          created_at: Date.now(),
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-A:review',
        task_id: 'task-1',
        agent_id: 'agent-A',
        role: 'review',
        status: 'pending',
        model: 'gpt-5.4',
        created_at: Date.now(),
      });

      // Task 2: pending, same group
      await store.createTask(
        makeTask({
          id: 'task-2',
          task_type: 'review',
          queue: 'review',
          group_id: 'group-div',
          status: 'pending',
          config,
          created_at: Date.now(),
        }),
      );

      // Same model but diversity disabled — should see task
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-B',
        model: 'gpt-5.4',
      });
      const body = await res.json();
      expect(body.tasks.filter((t: { task_id: string }) => t.task_id === 'task-2')).toHaveLength(1);
    });

    it('agent without model is visible even if models are claimed in group', async () => {
      const config = makeDiversityConfig();
      // Task 1: claimed with gpt-5.4
      await store.createTask(
        makeTask({
          id: 'task-1',
          task_type: 'review',
          queue: 'review',
          group_id: 'group-div',
          status: 'reviewing',
          config,
          created_at: Date.now(),
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-A:review',
        task_id: 'task-1',
        agent_id: 'agent-A',
        role: 'review',
        status: 'pending',
        model: 'gpt-5.4',
        created_at: Date.now(),
      });

      // Task 2: pending
      await store.createTask(
        makeTask({
          id: 'task-2',
          task_type: 'review',
          queue: 'review',
          group_id: 'group-div',
          status: 'pending',
          config,
          created_at: Date.now(),
        }),
      );

      // Agent with no model — should still see the task
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-B',
      });
      const body = await res.json();
      expect(body.tasks.filter((t: { task_id: string }) => t.task_id === 'task-2')).toHaveLength(1);
    });

    it('applies diversity check to summary tasks too', async () => {
      const config = makeDiversityConfig();
      // Review tasks: completed with various models
      await store.createTask(
        makeTask({
          id: 'task-w1',
          task_type: 'review',
          queue: 'review',
          group_id: 'group-div',
          status: 'completed',
          config,
          created_at: Date.now(),
        }),
      );
      await store.createClaim({
        id: 'task-w1:agent-A:review',
        task_id: 'task-w1',
        agent_id: 'agent-A',
        role: 'review',
        status: 'completed',
        model: 'gpt-5.4',
        review_text: 'LGTM',
        created_at: Date.now(),
      });
      await store.createTask(
        makeTask({
          id: 'task-w2',
          task_type: 'review',
          queue: 'review',
          group_id: 'group-div',
          status: 'completed',
          config,
          created_at: Date.now(),
        }),
      );
      await store.createClaim({
        id: 'task-w2:agent-B:review',
        task_id: 'task-w2',
        agent_id: 'agent-B',
        role: 'review',
        status: 'completed',
        model: 'gemini-2.5-pro',
        review_text: 'Looks good',
        created_at: Date.now(),
      });

      // Summary task: pending
      await store.createTask(
        makeTask({
          id: 'task-summary',
          task_type: 'summary',
          queue: 'summary',
          group_id: 'group-div',
          status: 'pending',
          config,
          created_at: Date.now(),
        }),
      );

      // Agent with gpt-5.4 — model already used in group — should be hidden during grace
      const res1 = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-C',
        model: 'gpt-5.4',
      });
      const body1 = await res1.json();
      const summaryTasks1 = body1.tasks.filter(
        (t: { task_id: string }) => t.task_id === 'task-summary',
      );
      expect(summaryTasks1).toHaveLength(0);

      // Agent with claude-sonnet-4-6 — different model — should see it
      const res2 = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-D',
        model: 'claude-sonnet-4-6',
      });
      const body2 = await res2.json();
      const summaryTasks2 = body2.tasks.filter(
        (t: { task_id: string }) => t.task_id === 'task-summary',
      );
      expect(summaryTasks2).toHaveLength(1);
    });

    it('considers completed tasks in group for model diversity check', async () => {
      const config = makeDiversityConfig();
      // Task 1: completed with gpt-5.4
      await store.createTask(
        makeTask({
          id: 'task-1',
          task_type: 'review',
          queue: 'review',
          group_id: 'group-div',
          status: 'completed',
          config,
          created_at: Date.now(),
        }),
      );
      await store.createClaim({
        id: 'task-1:agent-A:review',
        task_id: 'task-1',
        agent_id: 'agent-A',
        role: 'review',
        status: 'completed',
        model: 'gpt-5.4',
        review_text: 'Good code',
        created_at: Date.now(),
      });

      // Task 2: still pending
      await store.createTask(
        makeTask({
          id: 'task-2',
          task_type: 'review',
          queue: 'review',
          group_id: 'group-div',
          status: 'pending',
          config,
          created_at: Date.now(),
        }),
      );

      // Agent with gpt-5.4 — model already used (from completed task) — hidden during grace
      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-B',
        model: 'gpt-5.4',
      });
      const body = await res.json();
      expect(body.tasks.filter((t: { task_id: string }) => t.task_id === 'task-2')).toHaveLength(0);
    });
  });

  // ── Summary claim timeout recovery (#462) ──────────────────

  describe('summary claim timeout recovery (#462)', () => {
    it('task returns to pending after summary claim is reclaimed', async () => {
      const now = Date.now();
      // Summary task, agent-A claims it
      await store.createTask(makeTask({ queue: 'summary' }));
      const claimRes = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-A',
        role: 'summary',
      });
      expect(claimRes.status).toBe(200);

      // Verify task is now reviewing
      let task = await store.getTask('task-1');
      expect(task?.status).toBe('reviewing');

      // Simulate agent going stale (heartbeat expired)
      await store.setAgentLastSeen('agent-A', now - 300_000);

      // Reclaim abandoned claims — should free the claim AND release the task
      const freed = await store.reclaimAbandonedClaims(180_000);
      expect(freed).toBe(1);

      // Task should be back to pending
      task = await store.getTask('task-1');
      expect(task?.status).toBe('pending');

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

      // Task should be reviewing again
      const task = await store.getTask('task-1');
      expect(task?.status).toBe('reviewing');
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

  // ── Heartbeat kept alive via claim/result (#560) ─────────

  describe('heartbeat kept alive via claim/result (#560)', () => {
    it('claim refreshes heartbeat so reclaim does not trigger within threshold', async () => {
      await store.createTask(makeTask());

      // Agent polls (sets heartbeat)
      await request('POST', '/api/tasks/poll', { agent_id: 'agent-A' });

      // Agent claims the task (refreshes heartbeat)
      const claimRes = await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-A',
        role: 'summary',
      });
      expect(claimRes.status).toBe(200);

      // Heartbeat was just refreshed by claim — should NOT be reclaimed
      // even with a short threshold of 5 minutes
      const freed = await store.reclaimAbandonedClaims(300_000);
      expect(freed).toBe(0);

      // Task should still be reviewing
      const task = await store.getTask('task-1');
      expect(task?.status).toBe('reviewing');
    });

    it('result refreshes heartbeat so agent stays active after submission', async () => {
      await store.createTask(makeTask({ task_type: 'review', status: 'reviewing' }));
      await store.createClaim({
        id: 'task-1:agent-A:review',
        task_id: 'task-1',
        agent_id: 'agent-A',
        role: 'review',
        status: 'pending',
        created_at: Date.now(),
      });

      // Set agent heartbeat to 5 minutes ago (would be stale with old 3-min threshold)
      await store.setAgentLastSeen('agent-A', Date.now() - 300_000);

      // Agent submits result — this refreshes heartbeat
      const res = await request('POST', '/api/tasks/task-1/result', {
        agent_id: 'agent-A',
        type: 'review',
        review_text: 'Looks good!',
        verdict: 'approve',
      });
      expect(res.status).toBe(200);

      // Heartbeat should now be fresh
      const lastSeen = await store.getAgentLastSeen('agent-A');
      expect(lastSeen).not.toBeNull();
      expect(Date.now() - lastSeen!).toBeLessThan(1000);
    });

    it('truly abandoned agent is reclaimed after 10-minute threshold', async () => {
      await store.createTask(makeTask());

      // Agent claims the task
      await request('POST', '/api/tasks/task-1/claim', {
        agent_id: 'agent-A',
        role: 'summary',
      });

      // Simulate agent going stale: heartbeat 11 minutes ago
      await store.setAgentLastSeen('agent-A', Date.now() - 11 * 60 * 1000);

      // Reclaim with the actual 10-minute threshold — should free the claim
      const freed = await store.reclaimAbandonedClaims(10 * 60 * 1000);
      expect(freed).toBe(1);

      // Task should be back to pending
      const task = await store.getTask('task-1');
      expect(task?.status).toBe('pending');
    });
  });

  // ── Batch Poll ──────────────────────────────────────────────

  describe('POST /api/tasks/poll/batch', () => {
    it('returns empty assignments when nothing available', async () => {
      const res = await request('POST', '/api/tasks/poll/batch', {
        agents: [{ agent_name: 'agent-a', roles: ['review'] }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.assignments['agent-a'].tasks).toEqual([]);
    });

    it('returns tasks for a single agent', async () => {
      await store.createTask(makeTask({ task_type: 'review', review_count: 3, queue: 'review' }));
      const res = await request('POST', '/api/tasks/poll/batch', {
        agents: [{ agent_name: 'agent-a', roles: ['review'] }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.assignments['agent-a'].tasks).toHaveLength(1);
      expect(body.assignments['agent-a'].tasks[0].task_id).toBe('task-1');
    });

    it('returns per-agent assignments for multiple agents', async () => {
      await store.createTask(
        makeTask({
          id: 'task-r',
          task_type: 'review',
          review_count: 3,
          queue: 'review',
        }),
      );
      await store.createTask(
        makeTask({
          id: 'task-s',
          task_type: 'summary',
          queue: 'summary',
          group_id: 'g-1',
        }),
      );
      const res = await request('POST', '/api/tasks/poll/batch', {
        agents: [
          { agent_name: 'reviewer', roles: ['review'] },
          { agent_name: 'summarizer', roles: ['summary'] },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.assignments['reviewer'].tasks).toHaveLength(1);
      expect(body.assignments['reviewer'].tasks[0].task_id).toBe('task-r');
      expect(body.assignments['summarizer'].tasks).toHaveLength(1);
      expect(body.assignments['summarizer'].tasks[0].task_id).toBe('task-s');
    });

    it('deduplicates tasks across agents — no two agents get the same task', async () => {
      await store.createTask(
        makeTask({ id: 'task-1', task_type: 'review', review_count: 3, queue: 'review' }),
      );
      const res = await request('POST', '/api/tasks/poll/batch', {
        agents: [
          { agent_name: 'agent-a', roles: ['review'] },
          { agent_name: 'agent-b', roles: ['review'] },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // Exactly one agent should get the task
      const aCount = body.assignments['agent-a'].tasks.length;
      const bCount = body.assignments['agent-b'].tasks.length;
      expect(aCount + bCount).toBe(1);
    });

    it('dedup favors preferred model/tool match', async () => {
      await store.createTask(
        makeTask({
          id: 'task-pref',
          task_type: 'review',
          review_count: 3,
          queue: 'review',
          config: {
            ...DEFAULT_REVIEW_CONFIG,
            preferredModels: ['claude-opus'],
            preferredTools: [],
          },
        }),
      );
      const res = await request('POST', '/api/tasks/poll/batch', {
        agents: [
          { agent_name: 'generic', roles: ['review'], model: 'gpt-4' },
          { agent_name: 'preferred', roles: ['review'], model: 'claude-opus' },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // Preferred agent should win
      expect(body.assignments['preferred'].tasks).toHaveLength(1);
      expect(body.assignments['preferred'].tasks[0].task_id).toBe('task-pref');
      expect(body.assignments['generic'].tasks).toHaveLength(0);
    });

    it('distributes multiple tasks round-robin across agents', async () => {
      await store.createTask(
        makeTask({ id: 'task-1', task_type: 'review', review_count: 3, queue: 'review' }),
      );
      await store.createTask(
        makeTask({ id: 'task-2', task_type: 'review', review_count: 3, queue: 'review' }),
      );
      await store.createTask(
        makeTask({ id: 'task-3', task_type: 'review', review_count: 3, queue: 'review' }),
      );
      const res = await request('POST', '/api/tasks/poll/batch', {
        agents: [
          { agent_name: 'agent-a', roles: ['review'] },
          { agent_name: 'agent-b', roles: ['review'] },
          { agent_name: 'agent-c', roles: ['review'] },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // Round-robin: each agent gets exactly 1 task
      const aCount = body.assignments['agent-a'].tasks.length;
      const bCount = body.assignments['agent-b'].tasks.length;
      const cCount = body.assignments['agent-c'].tasks.length;
      expect(aCount).toBe(1);
      expect(bCount).toBe(1);
      expect(cCount).toBe(1);
      // No duplicates
      const allTaskIds = [
        ...body.assignments['agent-a'].tasks.map((t: { task_id: string }) => t.task_id),
        ...body.assignments['agent-b'].tasks.map((t: { task_id: string }) => t.task_id),
        ...body.assignments['agent-c'].tasks.map((t: { task_id: string }) => t.task_id),
      ];
      expect(new Set(allTaskIds).size).toBe(3);
    });

    it('filters tasks by agent role', async () => {
      await store.createTask(
        makeTask({ id: 'task-r', task_type: 'review', review_count: 3, queue: 'review' }),
      );
      await store.createTask(
        makeTask({ id: 'task-s', task_type: 'summary', queue: 'summary', group_id: 'g-2' }),
      );
      const res = await request('POST', '/api/tasks/poll/batch', {
        agents: [{ agent_name: 'review-only', roles: ['review'] }],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      // Should only see the review task
      expect(body.assignments['review-only'].tasks).toHaveLength(1);
      expect(body.assignments['review-only'].tasks[0].task_id).toBe('task-r');
    });

    it('rejects request with empty agents array', async () => {
      const res = await request('POST', '/api/tasks/poll/batch', { agents: [] });
      expect(res.status).toBe(400);
    });

    it('rejects request with missing roles', async () => {
      const res = await request('POST', '/api/tasks/poll/batch', {
        agents: [{ agent_name: 'agent-a' }],
      });
      expect(res.status).toBe(400);
    });

    it('rejects request with empty roles array', async () => {
      const res = await request('POST', '/api/tasks/poll/batch', {
        agents: [{ agent_name: 'agent-a', roles: [] }],
      });
      expect(res.status).toBe(400);
    });

    it('all agents get entries in assignments even with no tasks', async () => {
      const res = await request('POST', '/api/tasks/poll/batch', {
        agents: [
          { agent_name: 'agent-a', roles: ['review'] },
          { agent_name: 'agent-b', roles: ['summary'] },
        ],
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.assignments['agent-a']).toBeDefined();
      expect(body.assignments['agent-b']).toBeDefined();
      expect(body.assignments['agent-a'].tasks).toEqual([]);
      expect(body.assignments['agent-b'].tasks).toEqual([]);
    });

    it('rejects request with duplicate agent_name values', async () => {
      const res = await request('POST', '/api/tasks/poll/batch', {
        agents: [
          { agent_name: 'agent-a', roles: ['review'] },
          { agent_name: 'agent-a', roles: ['summary'] },
        ],
      });
      expect(res.status).toBe(400);
    });

    it('rejects request with more than 20 agents', async () => {
      const agents = Array.from({ length: 21 }, (_, i) => ({
        agent_name: `agent-${i}`,
        roles: ['review' as const],
      }));
      const res = await request('POST', '/api/tasks/poll/batch', { agents });
      expect(res.status).toBe(400);
    });

    it('existing single poll endpoint still works (backward compat)', async () => {
      await store.createTask(makeTask());
      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
    });
  });
});
