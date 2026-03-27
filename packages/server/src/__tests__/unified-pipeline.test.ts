/**
 * Tests for the unified pipeline refactor (issue #506).
 *
 * Tests the separate task model:
 * - Poll filters by task_type
 * - Claim validates role = task_type
 * - Worker result triggers summary task creation on group completion
 * - Summary result dispatches to correct handler by feature
 * - Dedup handler posts comment + updates index issue
 * - Triage handler posts comment/rewrites issue + applies labels
 */
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  DEFAULT_REVIEW_CONFIG,
  type ReviewTask,
  type TaskRole,
  type Feature,
} from '@opencara/shared';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import { resetTimeoutThrottle } from '../routes/tasks.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import { NoOpGitHubService } from '../github/service.js';
import type { GitHubService } from '../github/service.js';

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

function makeWorkerTask(
  id: string,
  groupId: string,
  taskType: TaskRole = 'review',
  feature: Feature = 'review',
  overrides: Partial<ReviewTask> = {},
): ReviewTask {
  return makeTask({
    id,
    task_type: taskType,
    feature,
    group_id: groupId,
    status: 'pending',
    ...overrides,
  });
}

function makeSummaryTask(
  id: string,
  groupId: string,
  feature: Feature = 'review',
  overrides: Partial<ReviewTask> = {},
): ReviewTask {
  return makeTask({
    id,
    task_type: 'summary',
    feature,
    group_id: groupId,
    status: 'pending',
    ...overrides,
  });
}

const mockEnv = {
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: 'test-key',
  WEB_URL: 'https://test.com',
};

describe('Unified Pipeline (Issue #506)', () => {
  let store: MemoryDataStore;
  let app: ReturnType<typeof createApp>;
  let github: GitHubService;

  beforeEach(() => {
    resetTimeoutThrottle();
    resetRateLimits();
    store = new MemoryDataStore();
    github = new NoOpGitHubService();
    app = createApp(store, github);
  });

  afterEach(() => {
    vi.restoreAllMocks();
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

  // ── Poll: task_type filtering ─────────────────────────────

  describe('Poll: task_type filtering', () => {
    it('returns tasks filtered by task_type matching agent roles', async () => {
      await store.createTask(makeWorkerTask('worker-1', 'g1', 'review', 'review'));
      await store.createTask(makeWorkerTask('dedup-1', 'g2', 'pr_dedup', 'dedup_pr'));
      await store.createTask(makeSummaryTask('summary-1', 'g3', 'review'));

      // Agent accepting only review
      const res1 = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        roles: ['review'],
      });
      const body1 = await res1.json();
      expect(body1.tasks).toHaveLength(1);
      expect(body1.tasks[0].task_id).toBe('worker-1');
      expect(body1.tasks[0].role).toBe('review');

      // Agent accepting dedup
      const res2 = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-2',
        roles: ['pr_dedup'],
      });
      const body2 = await res2.json();
      expect(body2.tasks).toHaveLength(1);
      expect(body2.tasks[0].task_id).toBe('dedup-1');
      expect(body2.tasks[0].role).toBe('pr_dedup');

      // Agent accepting summary
      const res3 = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-3',
        roles: ['summary'],
      });
      const body3 = await res3.json();
      expect(body3.tasks).toHaveLength(1);
      expect(body3.tasks[0].task_id).toBe('summary-1');
      expect(body3.tasks[0].role).toBe('summary');
    });

    it('returns all tasks when roles is omitted', async () => {
      await store.createTask(makeWorkerTask('w1', 'g1', 'review'));
      await store.createTask(makeWorkerTask('w2', 'g2', 'pr_dedup', 'dedup_pr'));
      await store.createTask(makeSummaryTask('s1', 'g3'));

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(3);
    });

    it('does not return reviewing or completed tasks', async () => {
      await store.createTask(
        makeWorkerTask('w1', 'g1', 'review', 'review', { status: 'reviewing' }),
      );
      await store.createTask(
        makeWorkerTask('w2', 'g2', 'review', 'review', { status: 'completed' }),
      );
      await store.createTask(makeWorkerTask('w3', 'g3', 'review', 'review', { status: 'pending' }));

      const res = await request('POST', '/api/tasks/poll', { agent_id: 'agent-1' });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].task_id).toBe('w3');
    });

    it('includes issue fields in poll response for issue tasks', async () => {
      await store.createTask(
        makeWorkerTask('triage-1', 'g1', 'issue_triage', 'triage', {
          issue_number: 42,
          issue_title: 'Bug: something broke',
          issue_body: 'Detailed description',
          pr_number: 0,
        }),
      );

      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'agent-1',
        roles: ['issue_triage'],
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].issue_number).toBe(42);
      expect(body.tasks[0].issue_title).toBe('Bug: something broke');
      expect(body.tasks[0].issue_body).toBe('Detailed description');
    });

    it('includes worker reviews in poll response for summary tasks', async () => {
      const groupId = 'review-group';
      // Create worker tasks
      await store.createTask(makeWorkerTask('w1', groupId, 'review'));
      await store.createTask(makeSummaryTask('s1', groupId));

      // Complete the worker task with a review
      await store.createClaim({
        id: 'w1:reviewer:review',
        task_id: 'w1',
        agent_id: 'reviewer',
        role: 'review',
        status: 'completed',
        review_text: 'Looks good overall',
        verdict: 'approve',
        model: 'claude-sonnet-4-6',
        tool: 'claude',
        created_at: Date.now(),
      });

      const res = await request('POST', '/api/tasks/poll', {
        agent_id: 'summarizer',
        roles: ['summary'],
      });
      const body = await res.json();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0].reviews).toHaveLength(1);
      expect(body.tasks[0].reviews[0].review_text).toBe('Looks good overall');
      expect(body.tasks[0].reviews[0].model).toBe('claude-sonnet-4-6');
    });
  });

  // ── Claim: role = task_type validation ────────────────────

  describe('Claim: role validation', () => {
    it('validates role matches task_type', async () => {
      await store.createTask(makeWorkerTask('w1', 'g1', 'review'));

      // Wrong role
      const res1 = await request('POST', '/api/tasks/w1/claim', {
        agent_id: 'agent-1',
        role: 'summary',
      });
      expect(res1.status).toBe(409);
      const body1 = await res1.json();
      expect(body1.error.message).toContain('does not match task type');

      // Correct role
      const res2 = await request('POST', '/api/tasks/w1/claim', {
        agent_id: 'agent-1',
        role: 'review',
      });
      expect(res2.status).toBe(200);
      const body2 = await res2.json();
      expect(body2.claimed).toBe(true);
    });

    it('uses atomic claimTask CAS for all task types', async () => {
      await store.createTask(makeWorkerTask('w1', 'g1', 'pr_dedup', 'dedup_pr'));

      // First claim succeeds
      const res1 = await request('POST', '/api/tasks/w1/claim', {
        agent_id: 'agent-1',
        role: 'pr_dedup',
      });
      expect(res1.status).toBe(200);

      // Task should be in reviewing state
      const task = await store.getTask('w1');
      expect(task?.status).toBe('reviewing');

      // Second claim fails (task already claimed)
      const res2 = await request('POST', '/api/tasks/w1/claim', {
        agent_id: 'agent-2',
        role: 'pr_dedup',
      });
      expect(res2.status).toBe(409);
    });

    it('returns worker reviews for summary claims', async () => {
      const groupId = 'review-group';
      await store.createTask(makeWorkerTask('w1', groupId, 'review'));
      await store.createTask(makeSummaryTask('s1', groupId));

      // Add completed review
      await store.createClaim({
        id: 'w1:reviewer:review',
        task_id: 'w1',
        agent_id: 'reviewer',
        role: 'review',
        status: 'completed',
        review_text: 'Detailed review text',
        verdict: 'comment',
        created_at: Date.now(),
      });

      const res = await request('POST', '/api/tasks/s1/claim', {
        agent_id: 'summarizer',
        role: 'summary',
      });
      const body = await res.json();
      expect(body.claimed).toBe(true);
      expect(body.reviews).toHaveLength(1);
      expect(body.reviews[0].review_text).toBe('Detailed review text');
    });

    it('accepts dedup and triage roles', async () => {
      await store.createTask(makeWorkerTask('d1', 'g1', 'pr_dedup', 'dedup_pr'));
      await store.createTask(makeWorkerTask('t1', 'g2', 'issue_triage', 'triage'));

      const res1 = await request('POST', '/api/tasks/d1/claim', {
        agent_id: 'agent-1',
        role: 'pr_dedup',
      });
      expect(res1.status).toBe(200);

      const res2 = await request('POST', '/api/tasks/t1/claim', {
        agent_id: 'agent-2',
        role: 'issue_triage',
      });
      expect(res2.status).toBe(200);
    });
  });

  // ── Worker result: group completion ───────────────────────

  describe('Worker result: group completion', () => {
    it('marks task completed and creates summary task when all workers done', async () => {
      const groupId = 'multi-worker-group';
      await store.createTask(makeWorkerTask('w1', groupId, 'review'));
      await store.createTask(makeWorkerTask('w2', groupId, 'review'));

      // Claim and submit first worker
      await request('POST', '/api/tasks/w1/claim', { agent_id: 'agent-1', role: 'review' });
      await request('POST', '/api/tasks/w1/result', {
        agent_id: 'agent-1',
        type: 'review',
        review_text: 'Review 1: Everything looks fine here. Good work on the implementation.',
        verdict: 'approve',
      });

      // w1 should be completed
      const w1 = await store.getTask('w1');
      expect(w1?.status).toBe('completed');

      // No summary task yet (w2 still pending)
      const groupTasks1 = await store.getTasksByGroup(groupId);
      const summaryTasks1 = groupTasks1.filter((t) => t.task_type === 'summary');
      expect(summaryTasks1).toHaveLength(0);

      // Claim and submit second worker
      await request('POST', '/api/tasks/w2/claim', { agent_id: 'agent-2', role: 'review' });
      await request('POST', '/api/tasks/w2/result', {
        agent_id: 'agent-2',
        type: 'review',
        review_text: 'Review 2: Found some minor issues but overall good quality code.',
        verdict: 'comment',
      });

      // w2 should be completed
      const w2 = await store.getTask('w2');
      expect(w2?.status).toBe('completed');

      // Summary task should now exist
      const groupTasks2 = await store.getTasksByGroup(groupId);
      const summaryTasks2 = groupTasks2.filter((t) => t.task_type === 'summary');
      expect(summaryTasks2).toHaveLength(1);
      expect(summaryTasks2[0].status).toBe('pending');
      expect(summaryTasks2[0].feature).toBe('review');
      expect(summaryTasks2[0].group_id).toBe(groupId);
    });

    it('does not create summary task until all workers complete', async () => {
      const groupId = 'three-worker';
      await store.createTask(makeWorkerTask('w1', groupId));
      await store.createTask(makeWorkerTask('w2', groupId));
      await store.createTask(makeWorkerTask('w3', groupId));

      // Complete only 2 of 3
      for (const id of ['w1', 'w2']) {
        await request('POST', `/api/tasks/${id}/claim`, { agent_id: `a-${id}`, role: 'review' });
        await request('POST', `/api/tasks/${id}/result`, {
          agent_id: `a-${id}`,
          type: 'review',
          review_text: `Review for ${id}: Detailed analysis of the code changes in this pull request.`,
          verdict: 'approve',
        });
      }

      // No summary yet
      const groupTasks = await store.getTasksByGroup(groupId);
      const summaries = groupTasks.filter((t) => t.task_type === 'summary');
      expect(summaries).toHaveLength(0);
    });

    it('dedup tasks dispatch directly as final tasks (no summary step)', async () => {
      const groupId = 'dedup-group';
      const postSpy = vi.spyOn(github, 'postPrComment');
      await store.createTask(
        makeWorkerTask('w1', groupId, 'pr_dedup', 'dedup_pr', { pr_number: 5 }),
      );

      await request('POST', '/api/tasks/w1/claim', { agent_id: 'agent-1', role: 'pr_dedup' });
      await request('POST', '/api/tasks/w1/result', {
        agent_id: 'agent-1',
        type: 'pr_dedup',
        review_text: 'Dedup analysis: No duplicates found in the codebase for this change.',
      });

      // Dedup task dispatches directly — no summary task created
      const groupTasks = await store.getTasksByGroup(groupId);
      expect(groupTasks).toHaveLength(0); // group deleted after dispatch

      // Posted comment on PR
      expect(postSpy).toHaveBeenCalled();
    });
  });

  // ── Summary result: feature dispatch ──────────────────────

  describe('Summary result: review feature', () => {
    it('posts review comment and deletes group on review summary', async () => {
      const groupId = 'review-group';
      const postSpy = vi.spyOn(github, 'postPrComment');

      // Create completed worker + summary task
      await store.createTask(
        makeWorkerTask('w1', groupId, 'review', 'review', { status: 'completed' }),
      );
      await store.createTask(makeSummaryTask('s1', groupId, 'review'));

      // Add worker claim with review text
      await store.createClaim({
        id: 'w1:r1:review',
        task_id: 'w1',
        agent_id: 'r1',
        role: 'review',
        status: 'completed',
        review_text:
          'Worker approved the implementation following best practices with quality standards for production deployment',
        verdict: 'approve',
        created_at: Date.now(),
      });

      // Claim and submit summary
      await request('POST', '/api/tasks/s1/claim', { agent_id: 'summarizer', role: 'summary' });
      const res = await request('POST', '/api/tasks/s1/result', {
        agent_id: 'summarizer',
        type: 'summary',
        review_text:
          'Summary: The worker review approved the code and found no major issues. The implementation follows best practices and is well-structured. The review text confirms that the overall quality meets the required standards for production deployment and maintainability.',
        verdict: 'approve',
      });
      expect(res.status).toBe(200);

      // Should have posted to GitHub
      expect(postSpy).toHaveBeenCalledWith(
        'test-org',
        'test-repo',
        1,
        expect.any(String),
        expect.any(String),
      );

      // Group should be deleted
      const remaining = await store.getTasksByGroup(groupId);
      expect(remaining).toHaveLength(0);
    });
  });

  describe('Summary result: dedup_pr feature', () => {
    it('posts dedup comment on PR and updates index issue', async () => {
      const groupId = 'dedup-pr-group';
      const postSpy = vi.spyOn(github, 'postPrComment');
      const updateSpy = vi.spyOn(github, 'updateIssue');
      const fetchBodySpy = vi.spyOn(github, 'fetchIssueBody');

      await store.createTask(
        makeWorkerTask('s1', groupId, 'pr_dedup', 'dedup_pr', {
          index_issue_number: 10,
          pr_number: 5,
        }),
      );

      await request('POST', '/api/tasks/s1/claim', { agent_id: 'dedup-agent', role: 'pr_dedup' });
      const res = await request('POST', '/api/tasks/s1/result', {
        agent_id: 'dedup-agent',
        type: 'pr_dedup',
        review_text:
          'Dedup analysis complete: This PR duplicates functionality found in PR #3 and PR #7. See detailed analysis below.',
        dedup_report: {
          duplicates: [{ number: 3, similarity: 'high', description: 'Same feature' }],
          index_entry: '- PR #5: duplicate of #3',
        },
      });
      expect(res.status).toBe(200);

      // Posted comment on PR
      expect(postSpy).toHaveBeenCalledWith(
        'test-org',
        'test-repo',
        5,
        expect.any(String),
        expect.any(String),
      );

      // Fetched index issue body
      expect(fetchBodySpy).toHaveBeenCalledWith('test-org', 'test-repo', 10, expect.any(String));

      // Updated index issue
      expect(updateSpy).toHaveBeenCalledWith(
        'test-org',
        'test-repo',
        10,
        expect.objectContaining({ body: expect.stringContaining('PR #5: duplicate of #3') }),
        expect.any(String),
      );

      // Group deleted
      const remaining = await store.getTasksByGroup(groupId);
      expect(remaining).toHaveLength(0);
    });
  });

  describe('Summary result: dedup_issue feature', () => {
    it('posts dedup comment on issue and updates index issue', async () => {
      const groupId = 'dedup-issue-group';
      const postSpy = vi.spyOn(github, 'postPrComment');

      await store.createTask(
        makeWorkerTask('s1', groupId, 'issue_dedup', 'dedup_issue', {
          issue_number: 42,
          index_issue_number: 10,
        }),
      );

      await request('POST', '/api/tasks/s1/claim', {
        agent_id: 'dedup-agent',
        role: 'issue_dedup',
      });
      const res = await request('POST', '/api/tasks/s1/result', {
        agent_id: 'dedup-agent',
        type: 'issue_dedup',
        review_text:
          'Dedup analysis: Issue #42 appears to be a duplicate of issue #15 based on the description and context.',
        dedup_report: {
          duplicates: [{ number: 15, similarity: 'exact', description: 'Same bug' }],
          index_entry: '- Issue #42: duplicate of #15',
        },
      });
      expect(res.status).toBe(200);

      // Posted comment on issue (uses postPrComment which works for issues too)
      expect(postSpy).toHaveBeenCalledWith(
        'test-org',
        'test-repo',
        42,
        expect.any(String),
        expect.any(String),
      );

      // Group deleted
      const remaining = await store.getTasksByGroup(groupId);
      expect(remaining).toHaveLength(0);
    });
  });

  describe('Summary result: triage feature', () => {
    it('posts triage comment on issue with labels', async () => {
      const groupId = 'triage-group';
      const postSpy = vi.spyOn(github, 'postPrComment');
      const updateSpy = vi.spyOn(github, 'updateIssue');

      await store.createTask(
        makeWorkerTask('s1', groupId, 'issue_triage', 'triage', {
          issue_number: 42,
          issue_author: 'user1',
          pr_number: 0,
        }),
      );

      await request('POST', '/api/tasks/s1/claim', {
        agent_id: 'triage-agent',
        role: 'issue_triage',
      });
      const res = await request('POST', '/api/tasks/s1/result', {
        agent_id: 'triage-agent',
        type: 'issue_triage',
        review_text:
          'Triage complete: This is a bug report related to authentication. Priority is high, size is medium.',
        triage_report: {
          category: 'bug',
          priority: 'high',
          size: 'M',
          labels: ['bug', 'auth'],
          comment: 'This is a bug in the authentication module. Priority: high, Size: M.',
        },
      });
      expect(res.status).toBe(200);

      // Posted comment
      expect(postSpy).toHaveBeenCalledWith(
        'test-org',
        'test-repo',
        42,
        expect.any(String),
        expect.any(String),
      );

      // Applied labels
      expect(updateSpy).toHaveBeenCalledWith(
        'test-org',
        'test-repo',
        42,
        expect.objectContaining({ labels: ['bug', 'auth'] }),
        expect.any(String),
      );

      // Group deleted
      const remaining = await store.getTasksByGroup(groupId);
      expect(remaining).toHaveLength(0);
    });

    it('rewrites issue when triage mode is rewrite', async () => {
      const groupId = 'triage-rewrite-group';
      const updateSpy = vi.spyOn(github, 'updateIssue');

      // Use a config with defaultMode='rewrite'
      const config = {
        ...DEFAULT_REVIEW_CONFIG,
        defaultMode: 'rewrite',
      };

      await store.createTask(
        makeWorkerTask('s1', groupId, 'issue_triage', 'triage', {
          issue_number: 42,
          issue_author: 'user1',
          pr_number: 0,
          config: config as ReviewTask['config'],
        }),
      );

      await request('POST', '/api/tasks/s1/claim', {
        agent_id: 'triage-agent',
        role: 'issue_triage',
      });
      const res = await request('POST', '/api/tasks/s1/result', {
        agent_id: 'triage-agent',
        type: 'issue_triage',
        review_text:
          'Triage complete with rewrite: Updated issue body and title for better clarity.',
        triage_report: {
          category: 'bug',
          priority: 'high',
          size: 'M',
          labels: ['bug'],
          summary: 'Auth module crashes on invalid token',
          body: 'Rewritten body with better structure and details about the authentication bug.',
          comment: 'This is a rewrite comment',
        },
      });
      expect(res.status).toBe(200);

      // Should rewrite the issue
      expect(updateSpy).toHaveBeenCalledWith(
        'test-org',
        'test-repo',
        42,
        expect.objectContaining({
          body: 'Rewritten body with better structure and details about the authentication bug.',
          title: 'Auth module crashes on invalid token',
          labels: ['bug'],
        }),
        expect.any(String),
      );
    });
  });

  // ── Reject/Error: release task ────────────────────────────

  describe('Reject and Error: task release', () => {
    it('releases task on reject so another agent can claim', async () => {
      await store.createTask(makeWorkerTask('w1', 'g1', 'review'));

      // Claim
      await request('POST', '/api/tasks/w1/claim', { agent_id: 'agent-1', role: 'review' });
      const task1 = await store.getTask('w1');
      expect(task1?.status).toBe('reviewing');

      // Reject
      await request('POST', '/api/tasks/w1/reject', {
        agent_id: 'agent-1',
        reason: 'Cannot process',
      });
      const task2 = await store.getTask('w1');
      expect(task2?.status).toBe('pending');

      // Another agent can claim
      const res = await request('POST', '/api/tasks/w1/claim', {
        agent_id: 'agent-2',
        role: 'review',
      });
      expect(res.status).toBe(200);
    });

    it('releases task on error so another agent can claim', async () => {
      await store.createTask(makeWorkerTask('w1', 'g1', 'review'));

      await request('POST', '/api/tasks/w1/claim', { agent_id: 'agent-1', role: 'review' });
      await request('POST', '/api/tasks/w1/error', {
        agent_id: 'agent-1',
        error: 'Tool crashed',
      });

      const task = await store.getTask('w1');
      expect(task?.status).toBe('pending');
    });
  });

  // ── Schema validation ─────────────────────────────────────

  describe('Schema validation', () => {
    it('accepts dedup and triage roles in claim', async () => {
      await store.createTask(makeWorkerTask('d1', 'g1', 'pr_dedup', 'dedup_pr'));

      const res = await request('POST', '/api/tasks/d1/claim', {
        agent_id: 'agent-1',
        role: 'pr_dedup',
      });
      expect(res.status).toBe(200);
    });

    it('accepts dedup_report in result', async () => {
      await store.createTask(makeWorkerTask('s1', 'g1', 'pr_dedup', 'dedup_pr', { pr_number: 5 }));
      await request('POST', '/api/tasks/s1/claim', { agent_id: 'agent-1', role: 'pr_dedup' });

      const res = await request('POST', '/api/tasks/s1/result', {
        agent_id: 'agent-1',
        type: 'pr_dedup',
        review_text:
          'Dedup analysis complete. Found potential duplicates in the repository codebase.',
        dedup_report: {
          duplicates: [{ number: 3, similarity: 'high', description: 'Same feature' }],
          index_entry: '- PR #5: dup of #3',
        },
      });
      expect(res.status).toBe(200);
    });

    it('accepts triage_report in result', async () => {
      await store.createTask(
        makeWorkerTask('s1', 'g1', 'issue_triage', 'triage', { issue_number: 42, pr_number: 0 }),
      );
      await request('POST', '/api/tasks/s1/claim', { agent_id: 'agent-1', role: 'issue_triage' });

      const res = await request('POST', '/api/tasks/s1/result', {
        agent_id: 'agent-1',
        type: 'issue_triage',
        review_text: 'Triage analysis complete. Categorized issue as a bug with high priority.',
        triage_report: {
          category: 'bug',
          priority: 'high',
          size: 'M',
          labels: ['bug'],
          comment: 'Triaged as high-priority bug.',
        },
      });
      expect(res.status).toBe(200);
    });
  });

  // ── End-to-end: full pipeline ─────────────────────────────

  describe('E2E: multi-agent review pipeline', () => {
    it('completes full review pipeline: 2 workers → summary → posted', async () => {
      const groupId = 'e2e-group';
      const postSpy = vi.spyOn(github, 'postPrComment');

      // Create 2 worker tasks
      await store.createTask(makeWorkerTask('w1', groupId));
      await store.createTask(makeWorkerTask('w2', groupId));

      // Agent 1 claims and submits
      await request('POST', '/api/tasks/w1/claim', { agent_id: 'a1', role: 'review' });
      await request('POST', '/api/tasks/w1/result', {
        agent_id: 'a1',
        type: 'review',
        review_text: 'Worker 1: Code review complete. Found no major issues in the implementation.',
        verdict: 'approve',
      });

      // Agent 2 claims and submits — triggers summary task creation
      await request('POST', '/api/tasks/w2/claim', { agent_id: 'a2', role: 'review' });
      await request('POST', '/api/tasks/w2/result', {
        agent_id: 'a2',
        type: 'review',
        review_text: 'Worker 2: Reviewed all changes. Code quality is good. Minor nit on naming.',
        verdict: 'comment',
      });

      // Summary task should exist
      const groupTasks = await store.getTasksByGroup(groupId);
      const summaryTask = groupTasks.find((t) => t.task_type === 'summary');
      expect(summaryTask).toBeDefined();

      // Summarizer claims and submits
      await request('POST', `/api/tasks/${summaryTask!.id}/claim`, {
        agent_id: 'summarizer',
        role: 'summary',
      });
      const res = await request('POST', `/api/tasks/${summaryTask!.id}/result`, {
        agent_id: 'summarizer',
        type: 'summary',
        review_text:
          'Combined review summary: Both reviewers found the code to be of good quality. Worker 1 completed the code review and found no major issues in the implementation. Worker 2 reviewed all changes and noted a minor naming suggestion. Overall the PR is ready to merge with confidence.',
        verdict: 'approve',
      });
      expect(res.status).toBe(200);

      // Review should be posted to GitHub
      expect(postSpy).toHaveBeenCalled();

      // All tasks in group should be deleted
      const remaining = await store.getTasksByGroup(groupId);
      expect(remaining).toHaveLength(0);
    });
  });
});
