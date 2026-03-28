/**
 * E2E scenario tests — simulate real agent behavior against the server.
 *
 * Uses test routes to inject PR events (no webhook signatures needed)
 * and MockAgent to simulate agent HTTP interactions.
 *
 * Mocks only the external boundary (GitHub API via global fetch).
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';
import { MemoryDataStore } from '../store/memory.js';
import { resetTimeoutThrottle } from '../routes/tasks.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import type { Env } from '../types.js';
import { createTestApp } from './helpers/test-server.js';
import { MockGitHubService } from './helpers/github-mock.js';
import { MockAgent } from './helpers/mock-agent.js';
import { VALID_SUMMARY_TEXT } from './helpers/test-constants.js';

// ── Setup ────────────────────────────────────────────────────

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
  };
}

describe('E2E Scenarios', () => {
  let store: MemoryDataStore;
  let app: ReturnType<typeof createTestApp>;
  let env: Env;
  let github: MockGitHubService;

  /** Helper: inject a PR event via test routes. Returns first task ID and group ID. */
  async function injectPR(opts?: {
    owner?: string;
    repo?: string;
    prNumber?: number;
    reviewCount?: number;
    timeout?: string;
  }): Promise<{ taskId: string; groupId: string }> {
    const config = {
      ...DEFAULT_REVIEW_CONFIG,
      agentCount: opts?.reviewCount ?? 1,
      ...(opts?.timeout ? { timeout: opts.timeout } : {}),
    };

    const res = await app.request(
      '/test/events/pr',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          owner: opts?.owner ?? 'test-org',
          repo: opts?.repo ?? 'test-repo',
          pr_number: opts?.prNumber ?? 1,
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
    resetTimeoutThrottle();
    resetRateLimits();
    store = new MemoryDataStore();
    github = new MockGitHubService();
    app = createTestApp(store, github);
    env = getMockEnv();
  });

  // ═══════════════════════════════════════════════════════════
  // A. Single-Agent Lifecycle
  // ═══════════════════════════════════════════════════════════

  describe('A. Single-Agent Lifecycle', () => {
    it('PR event → poll → claim summary → submit → GitHub review posted', async () => {
      const { taskId } = await injectPR();
      const a = agent('solo-agent');

      // Poll — sees task with summary role
      const tasks = await a.poll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].task_id).toBe(taskId);
      expect(tasks[0].role).toBe('summary');

      // Claim
      const claimRes = await a.claim(taskId, 'summary');
      expect(claimRes.claimed).toBe(true);
      if (claimRes.claimed) {
        expect(claimRes.reviews).toEqual([]); // No prior reviews in single-agent
      }

      // Verify task is now reviewing
      const task = await store.getTask(taskId);
      expect(task?.status).toBe('reviewing');

      // Submit result
      const result = await a.submitResult(taskId, 'summary', VALID_SUMMARY_TEXT, 'approve', 1000);
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);

      // Task deleted after successful post
      const finalTask = await store.getTask(taskId);
      expect(finalTask).toBeNull();

      // GitHub comment was posted
      const commentPost = github.calls.find((c) => c.method === 'postPrComment');
      expect(commentPost).toBeDefined();

      // No more tasks for polling
      const empty = await a.poll();
      expect(empty).toHaveLength(0);
    });

    it('second agent sees nothing after task is claimed', async () => {
      const { taskId } = await injectPR();
      const a1 = agent('agent-1');
      const a2 = agent('agent-2');

      await a1.claim(taskId, 'summary');
      const tasks = await a2.poll();
      expect(tasks).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // B. Multi-Agent Lifecycle
  // ═══════════════════════════════════════════════════════════

  describe('B. Multi-Agent Lifecycle', () => {
    it('2 reviewers each claim separate review tasks (new separate task model)', async () => {
      // reviewCount=3 → creates 2 separate review tasks (3-1=2)
      const { groupId } = await injectPR({ reviewCount: 3 });
      const r1 = agent('reviewer-1');
      const r2 = agent('reviewer-2');

      // Both reviewers poll — see 2 review tasks
      const r1Tasks = await r1.poll();
      expect(r1Tasks).toHaveLength(2);
      expect(r1Tasks[0].role).toBe('review');
      expect(r1Tasks[1].role).toBe('review');

      // Each reviewer claims a different task
      const task1Id = r1Tasks[0].task_id;
      const task2Id = r1Tasks[1].task_id;
      expect(task1Id).not.toBe(task2Id);

      const c1 = await r1.claim(task1Id, 'review');
      expect(c1.claimed).toBe(true);
      const c2 = await r2.claim(task2Id, 'review');
      expect(c2.claimed).toBe(true);

      // Each submits to their own task
      const r1Result = await r1.submitResult(
        task1Id,
        'review',
        'The implementation follows established patterns and conventions well.',
        'approve',
        500,
      );
      expect(r1Result.status).toBe(200);

      const r2Result = await r2.submitResult(
        task2Id,
        'review',
        'Error handling improvements needed throughout the modified code paths.',
        'request_changes',
        600,
      );
      expect(r2Result.status).toBe(200);

      // Both tasks share the same group_id (separate from task IDs)
      const allTasks = await store.getTasksByGroup(groupId);
      // Should now include 2 completed worker tasks + 1 auto-created summary task
      const workerTasks = allTasks.filter((t) => t.task_type !== 'summary');
      expect(workerTasks).toHaveLength(2);
      for (const t of workerTasks) {
        expect(t.group_id).toBe(groupId);
      }
    });

    it('third agent cannot claim review when all slots taken', async () => {
      // reviewCount=3 → 2 separate review tasks
      const { groupId } = await injectPR({ reviewCount: 3 });
      const workerIds = await getWorkerTaskIds(groupId);
      expect(workerIds).toHaveLength(2);

      const a1 = agent('a1');
      const a2 = agent('a2');
      const a3 = agent('a3');

      // Claim both tasks
      await a1.claim(workerIds[0], 'review');
      await a2.claim(workerIds[1], 'review');

      // Third agent — no pending tasks left
      const c3 = await a3.claim(workerIds[0], 'review');
      expect(c3.claimed).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // C. Rejection & Reclaim
  // ═══════════════════════════════════════════════════════════

  describe('C. Rejection & Reclaim', () => {
    it('claim → reject → slot freed → new agent claims → completes', async () => {
      const { taskId } = await injectPR();
      const a1 = agent('agent-1');
      const a2 = agent('agent-2');

      // Agent 1 claims and rejects
      await a1.claim(taskId, 'summary');
      const rejectRes = await a1.reject(taskId, 'Cannot access diff');
      expect(rejectRes.status).toBe(200);

      // Slot freed — agent 2 can claim
      const tasks = await a2.poll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].role).toBe('summary');

      const c2 = await a2.claim(taskId, 'summary');
      expect(c2.claimed).toBe(true);

      // Agent 2 completes
      const result = await a2.submitResult(taskId, 'summary', VALID_SUMMARY_TEXT, 'approve');
      expect(result.status).toBe(200);
    });

    it('review reject in multi-agent flow → new agent takes freed slot', async () => {
      // reviewCount=2 → 1 review task
      const { taskId } = await injectPR({ reviewCount: 2 });
      const a1 = agent('reviewer-1');
      const a2 = agent('reviewer-2');

      // Agent 1 claims review, then rejects
      await a1.claim(taskId, 'review');
      await a1.reject(taskId, 'Diff too large');

      // Agent 2 claims the freed review slot
      const tasks = await a2.poll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].role).toBe('review');

      const c2 = await a2.claim(taskId, 'review');
      expect(c2.claimed).toBe(true);
    });

    it('same agent can re-claim after rejection', async () => {
      const { taskId } = await injectPR();
      const a = agent('retry-agent');

      await a.claim(taskId, 'summary');
      await a.reject(taskId, 'Transient error');

      // Same agent polls again and re-claims
      const tasks = await a.poll();
      expect(tasks).toHaveLength(1);

      const c = await a.claim(taskId, 'summary');
      expect(c.claimed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // D. Error Recovery
  // ═══════════════════════════════════════════════════════════

  describe('D. Error Recovery', () => {
    it('claim → error → task freed → new agent claims → completes', async () => {
      // reviewCount=3 → 2 separate review tasks
      const { groupId } = await injectPR({ reviewCount: 3 });
      const workerIds = await getWorkerTaskIds(groupId);
      const firstTaskId = workerIds[0];
      const crasher = agent('crasher');
      const replacement = agent('replacement');

      // Agent crashes on first task
      await crasher.claim(firstTaskId, 'review');
      const errRes = await crasher.reportError(firstTaskId, 'SIGSEGV');
      expect(errRes.status).toBe(200);

      // Replacement agent polls — sees both review tasks (freed one + unclaimed one)
      const tasks = await replacement.poll();
      expect(tasks).toHaveLength(2);
      for (const t of tasks) {
        expect(t.role).toBe('review');
      }

      // Replacement claims the freed task
      const c = await replacement.claim(firstTaskId, 'review');
      expect(c.claimed).toBe(true);
    });

    it('summary error frees summary slot', async () => {
      const { taskId } = await injectPR();
      const a1 = agent('err-agent');
      const a2 = agent('recovery-agent');

      await a1.claim(taskId, 'summary');
      await a1.reportError(taskId, 'OOM');

      // Task should be back to pending after error
      const taskAfterError = await store.getTask(taskId);
      expect(taskAfterError?.status).toBe('pending');

      const tasks = await a2.poll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].role).toBe('summary');

      const c = await a2.claim(taskId, 'summary');
      expect(c.claimed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // E. Concurrent Claims
  // ═══════════════════════════════════════════════════════════

  describe('E. Concurrent Claims', () => {
    it('multiple agents claim same summary slot → only first succeeds', async () => {
      const { taskId } = await injectPR();
      const agents = [agent('fast'), agent('medium'), agent('slow')];

      const results = [];
      for (const a of agents) {
        results.push(await a.claim(taskId, 'summary'));
      }

      const claimed = results.filter((r) => r.claimed);
      const rejected = results.filter((r) => !r.claimed);
      expect(claimed).toHaveLength(1);
      expect(rejected).toHaveLength(2);
    });

    it('multiple agents can claim different review tasks', async () => {
      // reviewCount=4 → 3 separate review tasks
      const { groupId } = await injectPR({ reviewCount: 4 });
      const workerIds = await getWorkerTaskIds(groupId);
      expect(workerIds).toHaveLength(3);

      const agents = [agent('a1'), agent('a2'), agent('a3')];

      // Each agent claims a different task
      const results = [];
      for (let i = 0; i < agents.length; i++) {
        results.push(await agents[i].claim(workerIds[i], 'review'));
      }

      // All 3 should succeed (each claims a unique task)
      expect(results.every((r) => r.claimed)).toBe(true);

      // Fourth agent — no pending tasks left
      const a4 = agent('a4');
      const c4 = await a4.claim(workerIds[0], 'review');
      expect(c4.claimed).toBe(false);
    });

    it('duplicate summary claim rejected — task already claimed', async () => {
      const { taskId } = await injectPR();
      const a1 = agent('synth-1');
      const a2 = agent('synth-2');

      // Agent 1 claims summary — task moves to reviewing
      const c1 = await a1.claim(taskId, 'summary');
      expect(c1.claimed).toBe(true);

      // Task is in reviewing state now
      const task = await store.getTask(taskId);
      expect(task?.status).toBe('reviewing');

      // Agent 2 tries to claim — rejected because task is already claimed
      const c2 = await a2.claim(taskId, 'summary');
      expect(c2.claimed).toBe(false);
    });

    it('second summary result does not post duplicate GitHub comment (#221)', async () => {
      const { taskId } = await injectPR();

      // Manually create two summary claims — synth-a is the designated summary agent.
      // Verifies that only the summary_agent_id holder's result gets posted to GitHub.
      await store.createClaim({
        id: `${taskId}:synth-a:summary`,
        task_id: taskId,
        agent_id: 'synth-a',
        role: 'summary',
        status: 'pending',
        created_at: Date.now(),
      });
      await store.createClaim({
        id: `${taskId}:synth-b:summary`,
        task_id: taskId,
        agent_id: 'synth-b',
        role: 'summary',
        status: 'pending',
        created_at: Date.now(),
      });
      await store.updateTask(taskId, {
        queue: 'finished',
        summary_agent_id: 'synth-a',
        status: 'reviewing',
      });

      const synthA = agent('synth-a');
      const synthB = agent('synth-b');

      // Count GitHub comment calls before
      const commentsBefore = github.calls.filter((c) => c.method === 'postPrComment').length;

      // Agent A submits summary — is summary_agent_id, should post
      await synthA.submitResult(taskId, 'summary', VALID_SUMMARY_TEXT, 'approve');

      // Agent B submits summary — not summary_agent_id, result accepted but no GitHub post
      await synthB.submitResult(taskId, 'summary', VALID_SUMMARY_TEXT, 'approve');

      // Only 1 new comment should have been posted (not 2)
      const commentsAfter = github.calls.filter((c) => c.method === 'postPrComment').length;
      const newComments = commentsAfter - commentsBefore;
      expect(newComments).toBe(1);
    });

    it('same agent cannot double-claim', async () => {
      // reviewCount=3 → 2 review tasks
      const { groupId } = await injectPR({ reviewCount: 3 });
      const workerIds = await getWorkerTaskIds(groupId);
      const a = agent('greedy');

      const c1 = await a.claim(workerIds[0], 'review');
      expect(c1.claimed).toBe(true);

      // Same agent tries to claim the same task again — rejected
      const c2 = await a.claim(workerIds[0], 'review');
      expect(c2.claimed).toBe(false);
    });

    // Note: MemoryDataStore is synchronous, so Promise.all executes claims
    // serially in the same microtask turn. These tests validate the locking
    // logic at the API layer but cannot reproduce true I/O-level races that
    // occur with Cloudflare KV's eventual consistency.
    it('concurrent summary claims via Promise.all: exactly one wins (#273)', async () => {
      const { taskId } = await injectPR();

      // Fire 5 concurrent summary claims simultaneously
      const agents = Array.from({ length: 5 }, (_, i) => agent(`concurrent-${i}`));
      const results = await Promise.all(agents.map((a) => a.claim(taskId, 'summary')));

      const claimed = results.filter((r) => r.claimed === true);
      const rejected = results.filter((r) => r.claimed === false);

      // Exactly one agent should win the summary lock
      expect(claimed).toHaveLength(1);
      expect(rejected).toHaveLength(4);

      // All rejected agents should have an error
      for (const r of rejected) {
        if ('error' in r) {
          expect(r.error.code).toBeDefined();
        }
      }
    });

    it('concurrent claims + results: only one GitHub comment posted (#273)', async () => {
      const { taskId } = await injectPR();

      // Fire 3 concurrent summary claims
      const claimAgents = [agent('race-a'), agent('race-b'), agent('race-c')];
      const claimResults = await Promise.all(claimAgents.map((a) => a.claim(taskId, 'summary')));

      const winnerIdx = claimResults.findIndex((r) => r.claimed === true);
      expect(winnerIdx).toBeGreaterThanOrEqual(0);
      const winner = claimAgents[winnerIdx]!;

      // Count GitHub comment calls before
      const commentsBefore = github.calls.filter((c) => c.method === 'postPrComment').length;

      // Winner submits result
      await winner.submitResult(taskId, 'summary', VALID_SUMMARY_TEXT, 'approve');

      // Exactly 1 GitHub comment posted
      const commentsAfter = github.calls.filter((c) => c.method === 'postPrComment').length;
      expect(commentsAfter - commentsBefore).toBe(1);

      // Task should be deleted after successful post
      const task = await store.getTask(taskId);
      expect(task).toBeNull();
    });
  });

  // ═══════════════════════════════════════════════════════════
  // F. Timeout with Partial Results
  // ═══════════════════════════════════════════════════════════

  describe('F. Timeout with Partial Results', () => {
    it('some reviewers complete, timeout fires → partial results posted', async () => {
      // Create task with reviewCount=3 → 2 separate review tasks
      const { groupId } = await injectPR({ prNumber: 100, reviewCount: 3 });
      const workerIds = await getWorkerTaskIds(groupId);
      expect(workerIds).toHaveLength(2);

      // Simulate: one reviewer completes, then all tasks expire
      const r1 = agent('reviewer-1');
      await r1.claim(workerIds[0], 'review');
      await r1.submitResult(workerIds[0], 'review', 'Partial review content', 'comment', 300);

      // Manually expire all tasks in the group
      const allTasks = await store.getTasksByGroup(groupId);
      for (const t of allTasks) {
        await store.updateTask(t.id, { timeout_at: Date.now() - 1000 });
      }

      // Any agent polling triggers timeout check
      const poller = agent('poller');
      await poller.poll();

      // All tasks in group should be deleted after successful timeout post
      const remaining = await store.getTasksByGroup(groupId);
      expect(remaining).toHaveLength(0);

      // Should post exactly 1 consolidated comment (not N+1)
      const commentPosts = github.calls.filter((c) => c.method === 'postPrComment');
      expect(commentPosts.length).toBe(1);

      // Verify the single comment includes both timeout message and partial review
      const body = commentPosts[0].args.body as string;
      expect(body).toContain('timed out');
      expect(body).toContain('1 partial review(s) collected');
      expect(body).toContain('Partial review content');
    });

    it('claim rejected for expired task', async () => {
      const { taskId } = await injectPR();
      await store.updateTask(taskId, { timeout_at: Date.now() - 1000 });

      const a = agent('late-agent');
      const c = await a.claim(taskId, 'summary');
      expect(c.claimed).toBe(false);
      if ('error' in c) {
        expect(c.error.message).toContain('timed out');
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // G. Webhook Idempotency (via test routes)
  // ═══════════════════════════════════════════════════════════

  describe('G. Webhook Idempotency', () => {
    it('same PR event twice → only one task', async () => {
      await injectPR({ prNumber: 42 });

      // Second injection — should not create duplicate
      const res = await app.request(
        '/test/events/pr',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pr_number: 42 }),
        },
        env,
      );
      const body = (await res.json()) as { created: boolean };
      expect(body.created).toBe(false);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
    });

    it('different PRs create separate tasks', async () => {
      await injectPR({ prNumber: 10 });
      await injectPR({ prNumber: 11 });

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(2);
    });

    it('new task allowed after previous task deleted', async () => {
      const { taskId } = await injectPR({ prNumber: 50 });
      await store.deleteTask(taskId);

      // New event for same PR — should create new task
      const { taskId: newTaskId } = await injectPR({ prNumber: 50 });
      expect(newTaskId).not.toBe(taskId);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // H. Eligibility Filtering
  // ═══════════════════════════════════════════════════════════

  describe('H. Eligibility Filtering', () => {
    it('task with review_count=1 only offers summary role', async () => {
      const { taskId } = await injectPR({ reviewCount: 1 });
      const a = agent('agent');

      const tasks = await a.poll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].role).toBe('summary');

      // Trying to claim review should fail
      const c = await a.claim(taskId, 'review');
      expect(c.claimed).toBe(false);
    });

    it('deleted and failed tasks excluded from poll', async () => {
      const { taskId: t1 } = await injectPR({ prNumber: 1 });
      const { taskId: t2 } = await injectPR({ prNumber: 2 });
      const { taskId: t3 } = await injectPR({ prNumber: 3 });
      await injectPR({ prNumber: 4 }); // stays active

      // Simulate post-review deletion (completed/timeout tasks are deleted immediately)
      await store.deleteTask(t1);
      await store.deleteTask(t2);
      await store.updateTask(t3, { status: 'failed' });

      const a = agent('filter-agent');
      const tasks = await a.poll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].pr_number).toBe(4);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // I. Role Validation
  // ═══════════════════════════════════════════════════════════

  describe('I. Role Validation', () => {
    it('review claimer cannot submit as summary', async () => {
      // reviewCount=3 → 2 review tasks
      const { groupId } = await injectPR({ reviewCount: 3 });
      const workerIds = await getWorkerTaskIds(groupId);
      const a = agent('confused-agent');

      await a.claim(workerIds[0], 'review');
      // With role-aware claim IDs, the summary claim doesn't exist — returns 404
      const result = await a.submitResult(workerIds[0], 'summary', VALID_SUMMARY_TEXT);
      expect(result.status).toBe(404);
      expect(result.body.error.code).toBe('CLAIM_NOT_FOUND');
    });

    it('summary claimer cannot submit as review', async () => {
      const { taskId } = await injectPR({ reviewCount: 1 });
      const a = agent('confused-agent');

      await a.claim(taskId, 'summary');
      // With role-aware claim IDs, the review claim doesn't exist — returns 404
      const result = await a.submitResult(taskId, 'review', 'Individual review');
      expect(result.status).toBe(404);
      expect(result.body.error.code).toBe('CLAIM_NOT_FOUND');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // J. review_only Flag
  // ═══════════════════════════════════════════════════════════

  describe('J. review_only Flag', () => {
    it('agent with review_only sees only review tasks, not summary', async () => {
      // review_count=1 → only summary role (1 task)
      await injectPR({ prNumber: 1, reviewCount: 1 });
      // review_count=3 → review role (2 tasks: 3-1=2)
      await injectPR({ prNumber: 2, reviewCount: 3 });

      const a = agent('review-only-agent');

      // With review_only: should only see the review tasks (2 tasks from PR#2)
      const reviewTasks = await a.poll({ reviewOnly: true });
      expect(reviewTasks).toHaveLength(2);
      for (const t of reviewTasks) {
        expect(t.pr_number).toBe(2);
        expect(t.role).toBe('review');
      }
    });

    it('agent without review_only sees both review and summary tasks', async () => {
      await injectPR({ prNumber: 1, reviewCount: 1 }); // summary only (1 task)
      await injectPR({ prNumber: 2, reviewCount: 3 }); // review (2 tasks: 3-1=2)

      const a = agent('any-agent');
      const tasks = await a.poll();
      expect(tasks).toHaveLength(3); // 1 summary + 2 review

      const roles = tasks.map((t) => t.role).sort();
      expect(roles).toEqual(['review', 'review', 'summary']);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Verdict Case Normalization (issue #201)
  // ═══════════════════════════════════════════════════════════

  describe('Verdict in Comment Body', () => {
    it('uppercase verdict from agent is included in comment body text', async () => {
      const { taskId } = await injectPR();
      const a = agent('agent-uppercase');

      await a.claim(taskId, 'summary');

      const result = await a.submitResult(
        taskId,
        'summary',
        VALID_SUMMARY_TEXT,
        'APPROVE' as never,
        1000,
      );
      expect(result.status).toBe(200);

      // GitHub comment should have been posted (not a review)
      const commentPost = github.calls.find((c) => c.method === 'postPrComment');
      expect(commentPost).toBeDefined();
      // Verify comment body contains the summary text
      expect(commentPost!.args.body as string).toContain('important changes');
    });

    it('mixed-case verdict is included in comment body text', async () => {
      const { taskId } = await injectPR({ prNumber: 2 });
      const a = agent('agent-mixed');

      await a.claim(taskId, 'summary');

      const result = await a.submitResult(
        taskId,
        'summary',
        VALID_SUMMARY_TEXT,
        'Request_Changes' as never,
        800,
      );
      expect(result.status).toBe(200);

      const commentPost = github.calls.find(
        (c) => c.method === 'postPrComment' && c.args.prNumber === 2,
      );
      expect(commentPost).toBeDefined();
      expect(commentPost!.args.body as string).toContain('important changes');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // K. State Machine
  // ═══════════════════════════════════════════════════════════

  describe('K. State Machine', () => {
    it('cannot reject after task is deleted (post-completion)', async () => {
      const { taskId } = await injectPR();
      const a = agent('agent');

      await a.claim(taskId, 'summary');
      await a.submitResult(taskId, 'summary', VALID_SUMMARY_TEXT, 'approve');

      // Task + claims are deleted after successful post — returns 404
      const rejectRes = await a.reject(taskId, 'Too late');
      expect(rejectRes.status).toBe(404);
    });

    it('cannot error after task is deleted (post-completion)', async () => {
      const { taskId } = await injectPR();
      const a = agent('agent');

      await a.claim(taskId, 'summary');
      await a.submitResult(taskId, 'summary', VALID_SUMMARY_TEXT, 'approve');

      // Task + claims are deleted after successful post — returns 404
      const errRes = await a.reportError(taskId, 'Crash');
      expect(errRes.status).toBe(404);
    });

    it('idempotent reject — double reject returns 200', async () => {
      // reviewCount=3 → 2 review tasks
      const { groupId } = await injectPR({ reviewCount: 3 });
      const workerIds = await getWorkerTaskIds(groupId);
      const a = agent('agent');

      await a.claim(workerIds[0], 'review');
      const r1 = await a.reject(workerIds[0], 'First');
      expect(r1.status).toBe(200);

      const r2 = await a.reject(workerIds[0], 'Second');
      expect(r2.status).toBe(200);
    });

    it('idempotent error — double error returns 200', async () => {
      const { groupId } = await injectPR({ reviewCount: 3 });
      const workerIds = await getWorkerTaskIds(groupId);
      const a = agent('agent');

      await a.claim(workerIds[0], 'review');
      const e1 = await a.reportError(workerIds[0], 'Crash 1');
      expect(e1.status).toBe(200);

      const e2 = await a.reportError(workerIds[0], 'Crash 2');
      expect(e2.status).toBe(200);
    });

    it('cannot submit result twice — task deleted after first submit', async () => {
      const { taskId } = await injectPR();
      const a = agent('agent');

      await a.claim(taskId, 'summary');
      const r1 = await a.submitResult(taskId, 'summary', VALID_SUMMARY_TEXT);
      expect(r1.status).toBe(200);

      // Task + claims deleted after post — second submit returns 404
      const r2 = await a.submitResult(taskId, 'summary', VALID_SUMMARY_TEXT);
      expect(r2.status).toBe(404);
    });

    it('claim on deleted task (post-completion) is rejected', async () => {
      const { taskId } = await injectPR();
      const a1 = agent('agent-1');
      const a2 = agent('agent-2');

      await a1.claim(taskId, 'summary');
      await a1.submitResult(taskId, 'summary', VALID_SUMMARY_TEXT, 'approve');

      // Task deleted — returns 404 TASK_NOT_FOUND
      const c = await a2.claim(taskId, 'summary');
      expect(c.claimed).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Test Routes Verification
  // ═══════════════════════════════════════════════════════════

  describe('Test Routes', () => {
    it('POST /test/reset clears all data', async () => {
      await injectPR({ prNumber: 1 });
      await injectPR({ prNumber: 2 });

      let tasks = await store.listTasks();
      expect(tasks).toHaveLength(2);

      await app.request(
        '/test/reset',
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        env,
      );

      tasks = await store.listTasks();
      expect(tasks).toHaveLength(0);
    });

    it('GET /test/tasks returns all tasks', async () => {
      await injectPR({ prNumber: 1 });
      await injectPR({ prNumber: 2 });

      const res = await app.request('/test/tasks', { method: 'GET' }, env);
      const body = (await res.json()) as { tasks: unknown[] };
      expect(body.tasks).toHaveLength(2);
    });

    it('GET /test/claims/:taskId returns claims for a task', async () => {
      // reviewCount=3 → 2 review tasks
      const { groupId } = await injectPR({ reviewCount: 3 });
      const workerIds = await getWorkerTaskIds(groupId);
      const a = agent('agent');
      await a.claim(workerIds[0], 'review');

      const res = await app.request(`/test/claims/${workerIds[0]}`, { method: 'GET' }, env);
      const body = (await res.json()) as { claims: unknown[] };
      expect(body.claims).toHaveLength(1);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // H. KV Read-After-Write Staleness
  // ═══════════════════════════════════════════════════════════

  describe('H. KV Read-After-Write Staleness', () => {
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it('review is posted even when getClaim returns stale data without review_text', async () => {
      const { taskId } = await injectPR();
      const a = agent('stale-agent');

      // Claim
      await a.claim(taskId, 'summary');

      // Intercept getClaim to simulate KV staleness: return claim without review_text
      const originalGetClaim = store.getClaim.bind(store);
      vi.spyOn(store, 'getClaim').mockImplementation(async (claimId: string) => {
        const claim = await originalGetClaim(claimId);
        if (claim && claimId === `${taskId}:stale-agent:summary`) {
          // Simulate KV staleness — return claim without review_text
          return { ...claim, review_text: undefined };
        }
        return claim;
      });

      // Submit result — should still post to GitHub despite stale getClaim
      // because review_text is passed directly from the result endpoint
      const result = await a.submitResult(taskId, 'summary', VALID_SUMMARY_TEXT, 'approve', 500);
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);

      // Task should be deleted — review was posted despite stale KV read
      const finalTask = await store.getTask(taskId);
      expect(finalTask).toBeNull();

      // GitHub comment was posted with the correct review text
      const commentPost = github.calls.find((c) => c.method === 'postPrComment');
      expect(commentPost).toBeDefined();
      const commentBody = commentPost!.args.body as string;
      expect(commentBody).toContain('important changes');
    });

    it('server wraps review_text with title header and footer', async () => {
      const { taskId } = await injectPR();
      const a = agent('passthrough-agent');

      await a.claim(taskId, 'summary');

      // CLI submits raw review_text without header/footer
      const rawReview = VALID_SUMMARY_TEXT;
      const result = await a.submitResult(taskId, 'summary', rawReview, 'approve', 500);
      expect(result.status).toBe(200);

      // Server should wrap with exact header and footer structure
      const commentPost = github.calls.find((c) => c.method === 'postPrComment');
      expect(commentPost).toBeDefined();
      const commentBody = commentPost!.args.body as string;
      const expected = [
        '## OpenCara Review',
        '',
        rawReview,
        '',
        '---',
        '<sub>Reviewed by <a href="https://github.com/apps/opencara">OpenCara</a></sub>',
      ].join('\n');
      expect(commentBody).toBe(expected);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Late Review Results (Issue #370)
  // ═══════════════════════════════════════════════════════════
  //
  // In the new separate-task model, each worker has its own task.
  // "Late results" are handled gracefully: worker tasks that complete
  // after the summary task has been created still get marked completed,
  // but don't trigger duplicate summary creation.

  describe('Late Review Results', () => {
    it('late worker completion after summary task exists does not create duplicate summary', async () => {
      // Setup: reviewCount=3 → 2 worker tasks
      const { groupId } = await injectPR({ reviewCount: 3 });
      const workerIds = await getWorkerTaskIds(groupId);
      expect(workerIds).toHaveLength(2);

      const r1 = agent('reviewer-1');
      const r2 = agent('reviewer-2');

      // Both reviewers claim their tasks
      await r1.claim(workerIds[0], 'review');
      await r2.claim(workerIds[1], 'review');

      // r1 submits — 1 of 2 done, no summary yet
      await r1.submitResult(workerIds[0], 'review', 'Review 1: Analysis complete', 'approve', 500);
      let groupTasks = await store.getTasksByGroup(groupId);
      let summaryTasks = groupTasks.filter((t) => t.task_type === 'summary');
      expect(summaryTasks).toHaveLength(0);

      // r2 submits — 2 of 2 done, summary task auto-created
      await r2.submitResult(workerIds[1], 'review', 'Review 2: Analysis complete', 'approve', 600);
      groupTasks = await store.getTasksByGroup(groupId);
      summaryTasks = groupTasks.filter((t) => t.task_type === 'summary');
      expect(summaryTasks).toHaveLength(1);
    });

    it('summary task is only created once even with extra completed workers', async () => {
      // Setup: reviewCount=3 → 2 worker tasks + summary auto-created on completion
      const { groupId } = await injectPR({ reviewCount: 3 });
      const workerIds = await getWorkerTaskIds(groupId);

      const r1 = agent('reviewer-1');
      const r2 = agent('reviewer-2');

      // Both claim and both submit
      await r1.claim(workerIds[0], 'review');
      await r2.claim(workerIds[1], 'review');
      await r1.submitResult(workerIds[0], 'review', 'Review 1: Analysis complete', 'approve', 500);
      await r2.submitResult(workerIds[1], 'review', 'Review 2: Analysis complete', 'approve', 600);

      // Exactly one summary task
      const groupTasks = await store.getTasksByGroup(groupId);
      const summaryTasks = groupTasks.filter((t) => t.task_type === 'summary');
      expect(summaryTasks).toHaveLength(1);
      expect(summaryTasks[0].status).toBe('pending');
    });

    it('worker task statuses are independent — each tracks its own lifecycle', async () => {
      const { groupId } = await injectPR({ reviewCount: 3 });
      const workerIds = await getWorkerTaskIds(groupId);

      const r1 = agent('reviewer-1');
      const r2 = agent('reviewer-2');

      // r1 claims and submits
      await r1.claim(workerIds[0], 'review');
      await r1.submitResult(workerIds[0], 'review', 'Review 1: Analysis complete', 'approve', 500);

      // r1's task is completed
      const t1 = await store.getTask(workerIds[0]);
      expect(t1?.status).toBe('completed');

      // r2's task is still pending
      const t2 = await store.getTask(workerIds[1]);
      expect(t2?.status).toBe('pending');

      // r2 claims and submits
      await r2.claim(workerIds[1], 'review');
      await r2.submitResult(workerIds[1], 'review', 'Review 2: Analysis complete', 'approve', 600);

      // Both completed
      const t1Final = await store.getTask(workerIds[0]);
      const t2Final = await store.getTask(workerIds[1]);
      expect(t1Final?.status).toBe('completed');
      expect(t2Final?.status).toBe('completed');
    });

    it('summary creation checks all workers in group, not just threshold count', async () => {
      const { groupId } = await injectPR({ reviewCount: 3 });
      const workerIds = await getWorkerTaskIds(groupId);
      expect(workerIds).toHaveLength(2);

      const r1 = agent('reviewer-1');
      const r2 = agent('reviewer-2');

      // First review: 1 of 2 — should not create summary
      await r1.claim(workerIds[0], 'review');
      await r1.submitResult(workerIds[0], 'review', 'Review 1: Analysis complete', 'approve', 500);
      let groupTasks = await store.getTasksByGroup(groupId);
      expect(groupTasks.filter((t) => t.task_type === 'summary')).toHaveLength(0);

      // Second review: 2 of 2 — should create summary exactly once
      await r2.claim(workerIds[1], 'review');
      await r2.submitResult(workerIds[1], 'review', 'Review 2: Analysis complete', 'approve', 600);
      groupTasks = await store.getTasksByGroup(groupId);
      expect(groupTasks.filter((t) => t.task_type === 'summary')).toHaveLength(1);
    });

    it('concurrent review submissions create exactly one summary task (#551)', async () => {
      // Regression test for #551: summary task not created after all reviews complete.
      // When both results are submitted simultaneously, the atomic
      // completeWorkerAndMaybeCreateSummary ensures exactly one summary is created.
      const { groupId } = await injectPR({ reviewCount: 3 });
      const workerIds = await getWorkerTaskIds(groupId);
      expect(workerIds).toHaveLength(2);

      const r1 = agent('reviewer-1');
      const r2 = agent('reviewer-2');

      // Both agents claim their tasks
      await r1.claim(workerIds[0], 'review');
      await r2.claim(workerIds[1], 'review');

      // Both submit results concurrently (simulates the race condition)
      const [result1, result2] = await Promise.all([
        r1.submitResult(
          workerIds[0],
          'review',
          'Review 1: Thorough analysis complete',
          'approve',
          500,
        ),
        r2.submitResult(
          workerIds[1],
          'review',
          'Review 2: Code quality assessment done',
          'approve',
          600,
        ),
      ]);

      expect(result1.status).toBe(200);
      expect(result2.status).toBe(200);

      // Exactly one summary task should exist
      const groupTasks = await store.getTasksByGroup(groupId);
      const summaryTasks = groupTasks.filter((t) => t.task_type === 'summary');
      expect(summaryTasks).toHaveLength(1);
      expect(summaryTasks[0].status).toBe('pending');
    });
  });
});
