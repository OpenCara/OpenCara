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
import { createGitHubMock } from './helpers/github-mock.js';
import { MockAgent } from './helpers/mock-agent.js';

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
    TASK_STORE: {} as KVNamespace,
    WEB_URL: 'https://test.opencara.com',
  };
}

describe('E2E Scenarios', () => {
  let store: MemoryDataStore;
  let app: ReturnType<typeof createTestApp>;
  let env: Env;
  let github: ReturnType<typeof createGitHubMock>;

  /** Helper: inject a PR event via test routes. */
  async function injectPR(opts?: {
    owner?: string;
    repo?: string;
    prNumber?: number;
    reviewCount?: number;
    timeout?: string;
  }): Promise<string> {
    const config = {
      ...DEFAULT_REVIEW_CONFIG,
      agents: {
        ...DEFAULT_REVIEW_CONFIG.agents,
        reviewCount: opts?.reviewCount ?? 1,
      },
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
    const body = (await res.json()) as { created: boolean; task_id?: string };
    expect(body.created).toBe(true);
    return body.task_id!;
  }

  /** Create a MockAgent bound to the test app. */
  function agent(id: string): MockAgent {
    return new MockAgent(id, app, env);
  }

  beforeEach(() => {
    resetTimeoutThrottle();
    resetRateLimits();
    store = new MemoryDataStore();
    app = createTestApp(store);
    env = getMockEnv();
    github = createGitHubMock();
    github.install();
  });

  afterEach(() => {
    github.restore();
  });

  // ═══════════════════════════════════════════════════════════
  // A. Single-Agent Lifecycle
  // ═══════════════════════════════════════════════════════════

  describe('A. Single-Agent Lifecycle', () => {
    it('PR event → poll → claim summary → submit → GitHub review posted', async () => {
      const taskId = await injectPR();
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
      const result = await a.submitResult(
        taskId,
        'summary',
        '## Summary\nLooks good.\n\n## Verdict\nAPPROVE',
        'approve',
        1000,
      );
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);

      // Task completed
      const finalTask = await store.getTask(taskId);
      expect(['completed', 'failed']).toContain(finalTask?.status);

      // GitHub comment was posted
      const commentPost = github.calls.find(
        (c) => c.url.includes('/issues/') && c.url.includes('/comments') && c.method === 'POST',
      );
      expect(commentPost).toBeDefined();

      // No more tasks for polling
      const empty = await a.poll();
      expect(empty).toHaveLength(0);
    });

    it('second agent sees nothing after task is claimed', async () => {
      const taskId = await injectPR();
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
    it('2 reviewers → submit → synthesizer claims with reviews → submits → posted', async () => {
      const taskId = await injectPR({ reviewCount: 3 });
      const r1 = agent('reviewer-1');
      const r2 = agent('reviewer-2');
      const synth = agent('synthesizer');

      // Both reviewers poll — see review role
      const r1Tasks = await r1.poll();
      expect(r1Tasks[0].role).toBe('review');
      const r2Tasks = await r2.poll();
      expect(r2Tasks[0].role).toBe('review');

      // Both claim review
      const c1 = await r1.claim(taskId, 'review');
      expect(c1.claimed).toBe(true);
      const c2 = await r2.claim(taskId, 'review');
      expect(c2.claimed).toBe(true);

      // Synthesizer polls — nothing yet (reviews not complete)
      let synthTasks = await synth.poll();
      expect(synthTasks).toHaveLength(0);

      // Reviewer 1 submits
      await r1.submitResult(taskId, 'review', 'Review 1: LGTM', 'approve', 500);

      // Still no summary (only 1 of 2 reviews done)
      synthTasks = await synth.poll();
      expect(synthTasks).toHaveLength(0);

      // Reviewer 2 submits
      await r2.submitResult(taskId, 'review', 'Review 2: Needs work', 'request_changes', 600);

      // Summary now available
      synthTasks = await synth.poll();
      expect(synthTasks).toHaveLength(1);
      expect(synthTasks[0].role).toBe('summary');

      // Synthesizer claims — receives prior reviews
      const synthClaim = await synth.claim(taskId, 'summary');
      expect(synthClaim.claimed).toBe(true);
      if (synthClaim.claimed) {
        expect(synthClaim.reviews).toHaveLength(2);
        const agents = synthClaim.reviews!.map((r) => r.agent_id).sort();
        expect(agents).toEqual(['reviewer-1', 'reviewer-2']);
      }

      // Synthesizer submits
      const result = await synth.submitResult(
        taskId,
        'summary',
        '## Summary\nSynthesized.\n\n## Verdict\nCOMMENT',
        undefined,
        900,
      );
      expect(result.status).toBe(200);

      // All claims completed
      const claims = await store.getClaims(taskId);
      expect(claims).toHaveLength(3);
      expect(claims.filter((c) => c.status === 'completed')).toHaveLength(3);
    });

    it('third agent cannot claim review when all slots taken', async () => {
      const taskId = await injectPR({ reviewCount: 3 });
      const a1 = agent('a1');
      const a2 = agent('a2');
      const a3 = agent('a3');

      await a1.claim(taskId, 'review');
      await a2.claim(taskId, 'review');

      const c3 = await a3.claim(taskId, 'review');
      expect(c3.claimed).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // C. Rejection & Reclaim
  // ═══════════════════════════════════════════════════════════

  describe('C. Rejection & Reclaim', () => {
    it('claim → reject → slot freed → new agent claims → completes', async () => {
      const taskId = await injectPR();
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
      const result = await a2.submitResult(taskId, 'summary', 'Done.', 'approve');
      expect(result.status).toBe(200);
    });

    it('review reject in multi-agent flow → new agent takes freed slot', async () => {
      const taskId = await injectPR({ reviewCount: 2 });
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
      const taskId = await injectPR();
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
    it('claim → error → slot freed → new agent claims → completes', async () => {
      const taskId = await injectPR({ reviewCount: 3 });
      const crasher = agent('crasher');
      const replacement = agent('replacement');

      // Agent crashes
      await crasher.claim(taskId, 'review');
      const errRes = await crasher.reportError(taskId, 'SIGSEGV');
      expect(errRes.status).toBe(200);

      // Slot freed
      const task = await store.getTask(taskId);
      expect(task?.review_claims).toBe(0);
      expect(task?.claimed_agents).toEqual([]);

      // Replacement agent claims
      const tasks = await replacement.poll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].role).toBe('review');

      const c = await replacement.claim(taskId, 'review');
      expect(c.claimed).toBe(true);
    });

    it('summary error frees summary slot', async () => {
      const taskId = await injectPR();
      const a1 = agent('err-agent');
      const a2 = agent('recovery-agent');

      await a1.claim(taskId, 'summary');
      await a1.reportError(taskId, 'OOM');

      // Lock should be released after error
      expect(await store.isLockHeld(`summary:${taskId}`)).toBe(false);

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
      const taskId = await injectPR();
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

    it('multiple agents can claim different review slots', async () => {
      const taskId = await injectPR({ reviewCount: 4 });
      const agents = [agent('a1'), agent('a2'), agent('a3')];

      const results = [];
      for (const a of agents) {
        results.push(await a.claim(taskId, 'review'));
      }

      // All 3 should succeed (3 review slots for review_count=4)
      expect(results.every((r) => r.claimed)).toBe(true);

      // Fourth agent rejected
      const a4 = agent('a4');
      const c4 = await a4.claim(taskId, 'review');
      expect(c4.claimed).toBe(false);
    });

    it('duplicate summary claim rejected even with stale task counters (#221)', async () => {
      const taskId = await injectPR();
      const a1 = agent('synth-1');
      const a2 = agent('synth-2');

      // Agent 1 claims summary
      const c1 = await a1.claim(taskId, 'summary');
      expect(c1.claimed).toBe(true);

      // Simulate KV stale read: reset claimed_agents
      // (mimics what happens when a concurrent read returns stale data)
      // Lock is still held by synth-1
      await store.updateTask(taskId, { claimed_agents: [] });

      // Agent 2 tries to claim — lock prevents it
      const c2 = await a2.claim(taskId, 'summary');
      expect(c2.claimed).toBe(false);
    });

    it('second summary result does not post duplicate GitHub comment (#221)', async () => {
      const taskId = await injectPR();

      // Manually create two summary claims with agent-a holding the lock.
      // Verifies that only the lock holder's result gets posted to GitHub.
      await store.acquireLock(`summary:${taskId}`, 'synth-a');
      await store.createClaim({
        id: `${taskId}:synth-a`,
        task_id: taskId,
        agent_id: 'synth-a',
        role: 'summary',
        status: 'pending',
        created_at: Date.now(),
      });
      await store.createClaim({
        id: `${taskId}:synth-b`,
        task_id: taskId,
        agent_id: 'synth-b',
        role: 'summary',
        status: 'pending',
        created_at: Date.now(),
      });
      await store.updateTask(taskId, {
        claimed_agents: ['synth-a', 'synth-b'],
        status: 'reviewing',
      });

      const synthA = agent('synth-a');
      const synthB = agent('synth-b');

      // Count GitHub comment calls before
      const commentsBefore = github.calls.filter(
        (c) => c.url.includes('/issues/') && c.url.includes('/comments') && c.method === 'POST',
      ).length;

      // Agent A submits summary — holds lock, should post
      await synthA.submitResult(taskId, 'summary', '## Summary\nFirst.', 'approve');

      // Agent B submits summary — doesn't hold lock, result accepted but no GitHub post
      await synthB.submitResult(taskId, 'summary', '## Summary\nDuplicate.', 'approve');

      // Only 1 new comment should have been posted (not 2)
      const commentsAfter = github.calls.filter(
        (c) => c.url.includes('/issues/') && c.url.includes('/comments') && c.method === 'POST',
      ).length;
      const newComments = commentsAfter - commentsBefore;
      expect(newComments).toBe(1);
    });

    it('same agent cannot double-claim', async () => {
      const taskId = await injectPR({ reviewCount: 3 });
      const a = agent('greedy');

      const c1 = await a.claim(taskId, 'review');
      expect(c1.claimed).toBe(true);

      const c2 = await a.claim(taskId, 'review');
      expect(c2.claimed).toBe(false);
    });

    // Note: MemoryDataStore is synchronous, so Promise.all executes claims
    // serially in the same microtask turn. These tests validate the locking
    // logic at the API layer but cannot reproduce true I/O-level races that
    // occur with Cloudflare KV's eventual consistency.
    it('concurrent summary claims via Promise.all: exactly one wins (#273)', async () => {
      const taskId = await injectPR();

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
      const taskId = await injectPR();

      // Fire 3 concurrent summary claims
      const claimAgents = [agent('race-a'), agent('race-b'), agent('race-c')];
      const claimResults = await Promise.all(claimAgents.map((a) => a.claim(taskId, 'summary')));

      const winnerIdx = claimResults.findIndex((r) => r.claimed === true);
      expect(winnerIdx).toBeGreaterThanOrEqual(0);
      const winner = claimAgents[winnerIdx]!;

      // Count GitHub comment calls before
      const commentsBefore = github.calls.filter(
        (c) => c.url.includes('/issues/') && c.url.includes('/comments') && c.method === 'POST',
      ).length;

      // Winner submits result
      await winner.submitResult(taskId, 'summary', '## Summary\nLooks good.', 'approve');

      // Exactly 1 GitHub comment posted
      const commentsAfter = github.calls.filter(
        (c) => c.url.includes('/issues/') && c.url.includes('/comments') && c.method === 'POST',
      ).length;
      expect(commentsAfter - commentsBefore).toBe(1);

      // Task should be in terminal state
      const task = await store.getTask(taskId);
      expect(task).toBeDefined();
      expect(['completed', 'failed']).toContain(task!.status);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // F. Timeout with Partial Results
  // ═══════════════════════════════════════════════════════════

  describe('F. Timeout with Partial Results', () => {
    it('some reviewers complete, timeout fires → partial results posted', async () => {
      // Create task that's already expired
      const config = {
        ...DEFAULT_REVIEW_CONFIG,
        agents: { ...DEFAULT_REVIEW_CONFIG.agents, reviewCount: 3 },
      };

      const res = await app.request(
        '/test/events/pr',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            owner: 'test-org',
            repo: 'test-repo',
            pr_number: 100,
            config,
          }),
        },
        env,
      );
      const { task_id: taskId } = (await res.json()) as { task_id: string };

      // Simulate: one reviewer completed, then task expires
      const r1 = agent('reviewer-1');
      await r1.claim(taskId, 'review');
      await r1.submitResult(taskId, 'review', 'Partial review content', 'comment', 300);

      // Manually expire the task
      await store.updateTask(taskId, { timeout_at: Date.now() - 1000 });

      // Any agent polling triggers timeout check
      const poller = agent('poller');
      await poller.poll();

      // Task should be timed out
      const task = await store.getTask(taskId);
      expect(task?.status).toBe('timeout');

      // Partial review + timeout comment should have been posted as issue comments
      const commentPosts = github.calls.filter(
        (c) => c.url.includes('/issues/') && c.url.includes('/comments') && c.method === 'POST',
      );
      // At least 2: one for the partial review, one for the timeout message
      expect(commentPosts.length).toBeGreaterThanOrEqual(2);
    });

    it('claim rejected for expired task', async () => {
      const taskId = await injectPR();
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

    it('new task allowed after previous reached terminal state', async () => {
      const taskId = await injectPR({ prNumber: 50 });
      await store.updateTask(taskId, { status: 'completed' });

      // New event for same PR — should create new task
      const newTaskId = await injectPR({ prNumber: 50 });
      expect(newTaskId).not.toBe(taskId);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // H. Eligibility Filtering
  // ═══════════════════════════════════════════════════════════

  describe('H. Eligibility Filtering', () => {
    it('task with review_count=1 only offers summary role', async () => {
      const taskId = await injectPR({ reviewCount: 1 });
      const a = agent('agent');

      const tasks = await a.poll();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].role).toBe('summary');

      // Trying to claim review should fail
      const c = await a.claim(taskId, 'review');
      expect(c.claimed).toBe(false);
    });

    it('completed/timed-out/failed tasks excluded from poll', async () => {
      const t1 = await injectPR({ prNumber: 1 });
      const t2 = await injectPR({ prNumber: 2 });
      const t3 = await injectPR({ prNumber: 3 });
      await injectPR({ prNumber: 4 }); // stays active

      await store.updateTask(t1, { status: 'completed' });
      await store.updateTask(t2, { status: 'timeout' });
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
      const taskId = await injectPR({ reviewCount: 3 });
      const a = agent('confused-agent');

      await a.claim(taskId, 'review');
      const result = await a.submitResult(taskId, 'summary', 'Synthesized review');
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe('INVALID_REQUEST');
      expect(result.body.error.message).toContain("does not match submission type 'summary'");
    });

    it('summary claimer cannot submit as review', async () => {
      const taskId = await injectPR({ reviewCount: 1 });
      const a = agent('confused-agent');

      await a.claim(taskId, 'summary');
      const result = await a.submitResult(taskId, 'review', 'Individual review');
      expect(result.status).toBe(400);
      expect(result.body.error.code).toBe('INVALID_REQUEST');
      expect(result.body.error.message).toContain("does not match submission type 'review'");
    });
  });

  // ═══════════════════════════════════════════════════════════
  // J. review_only Flag
  // ═══════════════════════════════════════════════════════════

  describe('J. review_only Flag', () => {
    it('agent with review_only sees only review tasks, not summary', async () => {
      // review_count=1 → only summary role
      await injectPR({ prNumber: 1, reviewCount: 1 });
      // review_count=3 → review role
      await injectPR({ prNumber: 2, reviewCount: 3 });

      const a = agent('review-only-agent');

      // With review_only: should only see the review task
      const reviewTasks = await a.poll({ reviewOnly: true });
      expect(reviewTasks).toHaveLength(1);
      expect(reviewTasks[0].pr_number).toBe(2);
      expect(reviewTasks[0].role).toBe('review');
    });

    it('agent without review_only sees both review and summary tasks', async () => {
      await injectPR({ prNumber: 1, reviewCount: 1 }); // summary only
      await injectPR({ prNumber: 2, reviewCount: 3 }); // review

      const a = agent('any-agent');
      const tasks = await a.poll();
      expect(tasks).toHaveLength(2);

      const roles = tasks.map((t) => t.role).sort();
      expect(roles).toEqual(['review', 'summary']);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Verdict Case Normalization (issue #201)
  // ═══════════════════════════════════════════════════════════

  describe('Verdict in Comment Body', () => {
    it('uppercase verdict from agent is included in comment body text', async () => {
      const taskId = await injectPR();
      const a = agent('agent-uppercase');

      await a.claim(taskId, 'summary');

      const result = await a.submitResult(
        taskId,
        'summary',
        '## Summary\nLooks good.\n\n## Verdict\nAPPROVE',
        'APPROVE' as never,
        1000,
      );
      expect(result.status).toBe(200);

      // GitHub comment should have been posted (not a review)
      const commentPost = github.calls.find(
        (c) => c.url.includes('/issues/') && c.url.includes('/comments') && c.method === 'POST',
      );
      expect(commentPost).toBeDefined();
      // Verdict is in the comment body text
      expect((commentPost!.body as { body?: string }).body).toContain('APPROVE');
    });

    it('mixed-case verdict is included in comment body text', async () => {
      const taskId = await injectPR({ prNumber: 2 });
      const a = agent('agent-mixed');

      await a.claim(taskId, 'summary');

      const result = await a.submitResult(
        taskId,
        'summary',
        '## Summary\nNeeds changes.\n\n## Verdict\nrequest_changes',
        'Request_Changes' as never,
        800,
      );
      expect(result.status).toBe(200);

      const commentPost = github.calls.find(
        (c) => c.url.includes('/issues/2/comments') && c.method === 'POST',
      );
      expect(commentPost).toBeDefined();
      expect((commentPost!.body as { body?: string }).body).toContain('request_changes');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // K. State Machine
  // ═══════════════════════════════════════════════════════════

  describe('K. State Machine', () => {
    it('cannot reject a completed claim', async () => {
      const taskId = await injectPR();
      const a = agent('agent');

      await a.claim(taskId, 'summary');
      await a.submitResult(taskId, 'summary', 'Done.', 'approve');

      const rejectRes = await a.reject(taskId, 'Too late');
      expect(rejectRes.status).toBe(409);
    });

    it('cannot error a completed claim', async () => {
      const taskId = await injectPR();
      const a = agent('agent');

      await a.claim(taskId, 'summary');
      await a.submitResult(taskId, 'summary', 'Done.', 'approve');

      const errRes = await a.reportError(taskId, 'Crash');
      expect(errRes.status).toBe(409);
    });

    it('idempotent reject — double reject returns 200', async () => {
      const taskId = await injectPR({ reviewCount: 3 });
      const a = agent('agent');

      await a.claim(taskId, 'review');
      const r1 = await a.reject(taskId, 'First');
      expect(r1.status).toBe(200);

      const r2 = await a.reject(taskId, 'Second');
      expect(r2.status).toBe(200);
    });

    it('idempotent error — double error returns 200', async () => {
      const taskId = await injectPR({ reviewCount: 3 });
      const a = agent('agent');

      await a.claim(taskId, 'review');
      const e1 = await a.reportError(taskId, 'Crash 1');
      expect(e1.status).toBe(200);

      const e2 = await a.reportError(taskId, 'Crash 2');
      expect(e2.status).toBe(200);
    });

    it('cannot submit result twice on same claim', async () => {
      const taskId = await injectPR();
      const a = agent('agent');

      await a.claim(taskId, 'summary');
      const r1 = await a.submitResult(taskId, 'summary', 'First');
      expect(r1.status).toBe(200);

      const r2 = await a.submitResult(taskId, 'summary', 'Second');
      expect(r2.status).toBe(409);
    });

    it('claim on completed task is rejected', async () => {
      const taskId = await injectPR();
      const a1 = agent('agent-1');
      const a2 = agent('agent-2');

      await a1.claim(taskId, 'summary');
      await a1.submitResult(taskId, 'summary', 'Done', 'approve');

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
      const taskId = await injectPR({ reviewCount: 3 });
      const a = agent('agent');
      await a.claim(taskId, 'review');

      const res = await app.request(`/test/claims/${taskId}`, { method: 'GET' }, env);
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
      const taskId = await injectPR();
      const a = agent('stale-agent');

      // Claim
      await a.claim(taskId, 'summary');

      // Intercept getClaim to simulate KV staleness: return claim without review_text
      const originalGetClaim = store.getClaim.bind(store);
      vi.spyOn(store, 'getClaim').mockImplementation(async (claimId: string) => {
        const claim = await originalGetClaim(claimId);
        if (claim && claimId === `${taskId}:stale-agent`) {
          // Simulate KV staleness — return claim without review_text
          return { ...claim, review_text: undefined };
        }
        return claim;
      });

      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Submit result — should still post to GitHub despite stale getClaim
      const result = await a.submitResult(
        taskId,
        'summary',
        '## Summary\nThis should still be posted.',
        'approve',
        500,
      );
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);

      // Task should be completed — review was posted despite stale KV read
      const finalTask = await store.getTask(taskId);
      expect(finalTask?.status).toBe('completed');

      // GitHub comment was posted with the correct review text
      const commentPost = github.calls.find(
        (c) => c.url.includes('/issues/') && c.url.includes('/comments') && c.method === 'POST',
      );
      expect(commentPost).toBeDefined();
      expect(commentPost!.body).toBeDefined();
      const commentBody = (commentPost!.body as { body: string }).body;
      expect(commentBody).toContain('This should still be posted.');

      // Warning was logged about stale KV data
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('stale data'));
    });

    it('review uses model/tool from directly passed summary data, not stale KV', async () => {
      // Use multi-agent mode so synthesizer model/tool appears in the comment
      const taskId = await injectPR({ reviewCount: 2 });
      const reviewer = agent('reviewer-agent');
      const synth = agent('model-agent');

      // Reviewer claims and completes the review
      await reviewer.claim(taskId, 'review', { model: 'gpt-4', tool: 'other-cli' });
      await reviewer.submitResult(taskId, 'review', 'LGTM', 'approve', 300);

      // Synthesizer claims with correct model and tool
      await synth.claim(taskId, 'summary', { model: 'claude-3', tool: 'opencara-cli' });

      // Intercept getClaim to return stale data on the SECOND call (postFinalReview's
      // observability check), not the first call (result handler's claim lookup)
      const originalGetClaim = store.getClaim.bind(store);
      let callCount = 0;
      vi.spyOn(store, 'getClaim').mockImplementation(async (claimId: string) => {
        const claim = await originalGetClaim(claimId);
        if (claim && claimId === `${taskId}:model-agent`) {
          callCount++;
          if (callCount > 1) {
            // Second call (postFinalReview observability) — return stale data
            return { ...claim, review_text: undefined, model: 'stale-model', tool: 'stale-tool' };
          }
        }
        return claim;
      });

      vi.spyOn(console, 'warn').mockImplementation(() => {});

      // Submit result
      const result = await synth.submitResult(
        taskId,
        'summary',
        '## Summary\nModel test.',
        'approve',
        500,
      );
      expect(result.status).toBe(200);

      // GitHub comment should use the model/tool from the claim (set at claim time),
      // not the stale KV re-read
      const commentPost = github.calls.find(
        (c) => c.url.includes('/issues/') && c.url.includes('/comments') && c.method === 'POST',
      );
      expect(commentPost).toBeDefined();
      const commentBody = (commentPost!.body as { body: string }).body;
      // Should contain correct model/tool (formatted as `model/tool`) and NOT stale ones
      expect(commentBody).toContain('claude-3/opencara-cli');
      expect(commentBody).not.toContain('stale-model');
      expect(commentBody).not.toContain('stale-tool');
    });
  });
});
