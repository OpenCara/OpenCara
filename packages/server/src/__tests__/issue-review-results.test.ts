/**
 * E2E tests for issue review result synthesis and posting.
 *
 * Validates the full lifecycle: issue event → task creation → agent claim →
 * result submission → GitHub comment posted with "OpenCara Issue Review" header.
 */
import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { stubOAuthFetch, OAUTH_HEADERS } from './test-oauth-helper.js';
import { generateKeyPairSync } from 'node:crypto';
import { MemoryDataStore } from '../store/memory.js';
import { resetTimeoutThrottle, checkTimeouts } from '../routes/tasks.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import type { Env } from '../types.js';
import { createTestApp } from './helpers/test-server.js';
import { MockGitHubService } from './helpers/github-mock.js';
import { MockAgent } from './helpers/mock-agent.js';
import { VALID_SUMMARY_TEXT, VALID_MULTI_REVIEW_SUMMARY } from './helpers/test-constants.js';

let TEST_PEM: string;
beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  TEST_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
});

function getMockEnv(): Env {
  return {
    GITHUB_WEBHOOK_SECRET: 'test-secret',
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: TEST_PEM,
    WEB_URL: 'https://test.opencara.com',
    GITHUB_CLIENT_ID: 'cid',
    GITHUB_CLIENT_SECRET: 'csecret',
  };
}

describe('Issue Review Result Synthesis', () => {
  let store: MemoryDataStore;
  let app: ReturnType<typeof createTestApp>;
  let env: Env;
  let github: MockGitHubService;

  /** Helper: inject an issue event via test routes. */
  async function injectIssue(opts?: {
    owner?: string;
    repo?: string;
    issueNumber?: number;
    reviewCount?: number;
    timeout?: string;
  }): Promise<{ taskId: string; groupId: string }> {
    const config = {
      agentCount: opts?.reviewCount ?? 1,
      preferredModels: [] as string[],
      preferredTools: [] as string[],
      ...(opts?.timeout ? { timeout: opts.timeout } : {}),
    };

    const res = await app.request(
      '/test/events/issue',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
        body: JSON.stringify({
          owner: opts?.owner ?? 'test-org',
          repo: opts?.repo ?? 'test-repo',
          issue_number: opts?.issueNumber ?? 1,
          config,
        }),
      },
      env,
    );
    const body = (await res.json()) as { created: boolean; task_id?: string; group_id?: string };
    expect(body.created).toBe(true);
    return { taskId: body.task_id!, groupId: body.group_id! };
  }

  /** Get all pending worker task IDs in a group. */
  async function getWorkerTaskIds(groupId: string): Promise<string[]> {
    const tasks = await store.getTasksByGroup(groupId);
    return tasks
      .filter((t) => t.task_type !== 'summary' && t.status === 'pending')
      .map((t) => t.id);
  }

  /** Create a MockAgent bound to the test app. */
  function agent(id: string): MockAgent {
    return new MockAgent(id, app, env);
  }

  beforeEach(() => {
    stubOAuthFetch();
    resetTimeoutThrottle();
    resetRateLimits();
    store = new MemoryDataStore();
    github = new MockGitHubService();
    app = createTestApp(store, github);
    env = getMockEnv();
  });

  // ═══════════════════════════════════════════════════════════
  // A. Single-Agent Issue Review
  // ═══════════════════════════════════════════════════════════

  describe('A. Single-Agent Issue Review', () => {
    it('issue event → worker → summary → comment posted with "OpenCara Issue Review" header', async () => {
      // reviewCount=1 → 1 worker task (issue_review type) → auto-creates summary
      const { taskId } = await injectIssue();
      const worker = agent('solo-reviewer');

      // Poll — sees worker task with issue_review role
      const tasks = await worker.poll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].task_id).toBe(taskId);
      expect(tasks[0].role).toBe('issue_review');

      // Claim worker task
      const claimRes = await worker.claim(taskId, 'issue_review');
      expect(claimRes.claimed).toBe(true);

      // Submit worker result — triggers auto-creation of summary task
      const result = await worker.submitResult(
        taskId,
        'issue_review',
        'This issue is well-structured with clear acceptance criteria.',
        'comment',
        1000,
      );
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);

      // Summary task auto-created — synthesizer claims and submits
      const synth = agent('synthesizer');
      const synthTasks = await synth.poll();
      expect(synthTasks).toHaveLength(1);
      expect(synthTasks[0].role).toBe('summary');

      await synth.claim(synthTasks[0].task_id, 'summary');
      await synth.submitResult(synthTasks[0].task_id, 'summary', VALID_SUMMARY_TEXT, 'comment');

      // GitHub comment was posted
      const commentPost = github.calls.find((c) => c.method === 'postPrComment');
      expect(commentPost).toBeDefined();

      // Comment posted to the issue (issue_number=1), not a PR
      const args = commentPost!.args as { prNumber: number; body: string };
      expect(args.prNumber).toBe(1); // issue_number is passed as prNumber to postPrComment

      // Comment contains "OpenCara Issue Review" header
      expect(args.body).toContain('## OpenCara Issue Review');
    });

    it('single agent worker + summary lifecycle posts exactly one comment', async () => {
      const { taskId } = await injectIssue({ reviewCount: 1 });
      const worker = agent('solo');

      // Claim and submit worker result
      await worker.claim(taskId, 'issue_review');
      await worker.submitResult(
        taskId,
        'issue_review',
        'This issue needs clearer acceptance criteria and edge case coverage.',
        'comment',
        500,
      );

      // Claim and submit summary
      const synth = agent('synth');
      const synthTasks = await synth.poll();
      expect(synthTasks).toHaveLength(1);
      await synth.claim(synthTasks[0].task_id, 'summary');
      await synth.submitResult(synthTasks[0].task_id, 'summary', VALID_SUMMARY_TEXT, 'comment');

      // Exactly one comment posted
      expect(github.commentCount).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // B. Multi-Agent Issue Review
  // ═══════════════════════════════════════════════════════════

  describe('B. Multi-Agent Issue Review', () => {
    it('multiple reviewers → synthesis → combined comment posted', async () => {
      // reviewCount=3 → 2 worker tasks + summary auto-created on completion
      const { groupId } = await injectIssue({ reviewCount: 3 });
      const workerIds = await getWorkerTaskIds(groupId);
      expect(workerIds).toHaveLength(2);

      const r1 = agent('reviewer-1');
      const r2 = agent('reviewer-2');

      // Each reviewer claims and submits
      await r1.claim(workerIds[0], 'issue_review');
      await r1.submitResult(
        workerIds[0],
        'issue_review',
        'The issue lacks clear acceptance criteria and needs more detail on the expected behavior.',
        'comment',
        500,
      );

      await r2.claim(workerIds[1], 'issue_review');
      await r2.submitResult(
        workerIds[1],
        'issue_review',
        'This issue is well-structured but missing edge case considerations for error scenarios.',
        'comment',
        600,
      );

      // Summary task should be auto-created
      const allTasks = await store.getTasksByGroup(groupId);
      const summaryTask = allTasks.find((t) => t.task_type === 'summary');
      expect(summaryTask).toBeDefined();
      expect(summaryTask!.feature).toBe('issue_review');
      expect(summaryTask!.status).toBe('pending');

      // Synthesizer claims and submits
      const synth = agent('synthesizer');
      const synthTasks = await synth.poll();
      const synthTask = synthTasks.find((t) => t.role === 'summary');
      expect(synthTask).toBeDefined();

      await synth.claim(synthTask!.task_id, 'summary');
      await synth.submitResult(
        synthTask!.task_id,
        'summary',
        VALID_MULTI_REVIEW_SUMMARY,
        'comment',
        800,
      );

      // Comment posted to the issue with correct header
      const commentPost = github.calls.find((c) => c.method === 'postPrComment');
      expect(commentPost).toBeDefined();
      const args = commentPost!.args as { prNumber: number; body: string };
      expect(args.body).toContain('## OpenCara Issue Review');

      // All tasks in the group are cleaned up
      const remaining = await store.getTasksByGroup(groupId);
      expect(remaining).toHaveLength(0);
    });

    it('contributor names included in comment header', async () => {
      // reviewCount=2 → 1 worker + auto-summary
      const { groupId } = await injectIssue({ reviewCount: 2 });
      const workerIds = await getWorkerTaskIds(groupId);
      expect(workerIds).toHaveLength(1);

      const r1 = agent('contributor-agent');

      // Claim with a github_username set via the claim endpoint
      // The claim stores github_username from the OAuth identity
      await r1.claim(workerIds[0], 'issue_review');

      // Manually set github_username on the claim for testing
      const claims = await store.getClaims(workerIds[0]);
      expect(claims).toHaveLength(1);
      await store.updateClaim(claims[0].id, { github_username: 'contrib-user' });

      await r1.submitResult(
        workerIds[0],
        'issue_review',
        'The issue description is comprehensive and well-organized for implementation.',
        'comment',
        500,
      );

      // Summary task auto-created → claim and submit
      const allTasks = await store.getTasksByGroup(groupId);
      const summaryTask = allTasks.find((t) => t.task_type === 'summary');
      expect(summaryTask).toBeDefined();

      const synth = agent('synthesizer');
      await synth.claim(summaryTask!.id, 'summary');
      await synth.submitResult(summaryTask!.id, 'summary', VALID_SUMMARY_TEXT, 'comment');

      // Check contributor attribution in the posted comment
      const commentPost = github.calls.find((c) => c.method === 'postPrComment');
      expect(commentPost).toBeDefined();
      const body = (commentPost!.args as { body: string }).body;
      expect(body).toContain('@contrib-user');
      expect(body).toContain('**Contributors**');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // C. Timeout Handling
  // ═══════════════════════════════════════════════════════════

  describe('C. Timeout Handling', () => {
    it('timeout with partial results posts available reviews to issue', async () => {
      // Create issue with short timeout
      const { groupId } = await injectIssue({ reviewCount: 3, timeout: '1s' });
      const workerIds = await getWorkerTaskIds(groupId);
      expect(workerIds).toHaveLength(2);

      const r1 = agent('fast-reviewer');

      // One reviewer completes
      await r1.claim(workerIds[0], 'issue_review');
      await r1.submitResult(
        workerIds[0],
        'issue_review',
        'This issue needs clearer acceptance criteria and edge case coverage.',
        'comment',
        500,
      );

      // Force-expire remaining tasks
      const remaining = await store.getTasksByGroup(groupId);
      for (const t of remaining) {
        if (t.status === 'pending') {
          await store.updateTask(t.id, { timeout_at: Date.now() - 1000 });
        }
      }

      // Trigger timeout check
      await checkTimeouts(store, github);

      // Comment posted to the issue (not PR)
      const commentPost = github.calls.find((c) => c.method === 'postPrComment');
      expect(commentPost).toBeDefined();
      const args = commentPost!.args as { prNumber: number; body: string };

      // Posted to issue_number (1), not a PR
      expect(args.prNumber).toBe(1);

      // Contains partial review info
      expect(args.body).toContain('timed out');
      expect(args.body).toContain('partial review');

      // All tasks cleaned up
      const finalTasks = await store.getTasksByGroup(groupId);
      expect(finalTasks).toHaveLength(0);
    });

    it('timeout with no completed reviews posts timeout message to issue', async () => {
      const { groupId } = await injectIssue({ reviewCount: 2, timeout: '1s' });

      // Force-expire all tasks without any agent completing
      const tasks = await store.getTasksByGroup(groupId);
      for (const t of tasks) {
        await store.updateTask(t.id, { timeout_at: Date.now() - 1000 });
      }

      await checkTimeouts(store, github);

      // Timeout comment posted
      const commentPost = github.calls.find((c) => c.method === 'postPrComment');
      expect(commentPost).toBeDefined();
      const args = commentPost!.args as { prNumber: number; body: string };

      // Posted to issue, not PR
      expect(args.prNumber).toBe(1);
      expect(args.body).toContain('timed out');

      // All tasks cleaned up
      const finalTasks = await store.getTasksByGroup(groupId);
      expect(finalTasks).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // D. Edge Cases
  // ═══════════════════════════════════════════════════════════

  describe('D. Edge Cases', () => {
    it('issue review tasks have pr_number=0 and issue_number set', async () => {
      const { groupId } = await injectIssue({ issueNumber: 42, reviewCount: 2 });
      const tasks = await store.getTasksByGroup(groupId);

      for (const t of tasks) {
        expect(t.pr_number).toBe(0);
        expect(t.issue_number).toBe(42);
        expect(t.feature).toBe('issue_review');
      }
    });

    it('issue review tasks have correct issue metadata', async () => {
      const res = await app.request(
        '/test/events/issue',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...OAUTH_HEADERS },
          body: JSON.stringify({
            owner: 'my-org',
            repo: 'my-repo',
            issue_number: 99,
            issue_title: 'Bug: login fails',
            issue_body: 'Users cannot log in when...',
            issue_author: 'reporter-user',
            config: { agentCount: 1 },
          }),
        },
        env,
      );
      const body = (await res.json()) as { created: boolean; group_id: string };
      expect(body.created).toBe(true);

      const tasks = await store.getTasksByGroup(body.group_id);
      expect(tasks).toHaveLength(1);
      expect(tasks[0].issue_number).toBe(99);
      expect(tasks[0].issue_title).toBe('Bug: login fails');
      expect(tasks[0].issue_body).toBe('Users cannot log in when...');
      expect(tasks[0].issue_author).toBe('reporter-user');
      expect(tasks[0].issue_url).toBe('https://github.com/my-org/my-repo/issues/99');
    });

    it('no more tasks available after issue review completed', async () => {
      const { taskId } = await injectIssue();
      const worker = agent('worker');
      const synth = agent('synth');

      // Complete worker phase
      await worker.claim(taskId, 'issue_review');
      await worker.submitResult(taskId, 'issue_review', VALID_SUMMARY_TEXT, 'comment');

      // Complete summary phase
      const synthTasks = await synth.poll();
      expect(synthTasks).toHaveLength(1);
      await synth.claim(synthTasks[0].task_id, 'summary');
      await synth.submitResult(synthTasks[0].task_id, 'summary', VALID_SUMMARY_TEXT, 'comment');

      const empty = await worker.poll();
      expect(empty).toHaveLength(0);
    });

    it('MockAgent.injectIssue helper works correctly', async () => {
      const a = agent('test-agent');
      const result = await a.injectIssue({ issueNumber: 10, reviewCount: 2 });
      expect(result.created).toBe(true);
      expect(result.taskId).toBeDefined();
      expect(result.groupId).toBeDefined();

      const tasks = await store.getTasksByGroup(result.groupId!);
      expect(tasks).toHaveLength(1); // reviewCount=2 → 1 worker task
      expect(tasks[0].feature).toBe('issue_review');
      expect(tasks[0].issue_number).toBe(10);
    });
  });
});
