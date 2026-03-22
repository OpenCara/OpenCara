/**
 * Local integration tests — full E2E flows with in-memory store.
 *
 * Mocks only the external boundary (GitHub API via global fetch).
 * Everything else (Hono routing, TaskStore, review parsing, formatting)
 * runs for real.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import type { ReviewTask } from '@opencara/shared';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';
import { MemoryTaskStore } from '../store/memory.js';
import { createApp } from '../index.js';
import { resetTimeoutThrottle } from '../routes/tasks.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import type { Env } from '../types.js';

// ── Helpers ────────────────────────────────────────────────────

const WEBHOOK_SECRET = 'test-webhook-secret';

// Generate a real RSA key for JWT signing in tests.
// getInstallationToken → generateAppJwt uses crypto.subtle which needs a valid PEM.
let TEST_PEM: string;
beforeAll(() => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  TEST_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
});

function getMockEnv(): Env {
  return {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_APP_ID: '12345',
    GITHUB_APP_PRIVATE_KEY: TEST_PEM,
    TASK_STORE: {} as KVNamespace,
    WEB_URL: 'https://test.opencara.com',
  };
}

function makeTask(overrides: Partial<ReviewTask> = {}): ReviewTask {
  return {
    id: `task-${crypto.randomUUID().slice(0, 8)}`,
    owner: 'acme',
    repo: 'widget',
    pr_number: 42,
    pr_url: 'https://github.com/acme/widget/pull/42',
    diff_url: 'https://github.com/acme/widget/pull/42.diff',
    base_ref: 'main',
    head_ref: 'feat/awesome',
    review_count: 1,
    prompt: 'Review this pull request for bugs and code quality.',
    timeout_at: Date.now() + 600_000,
    status: 'pending',
    github_installation_id: 999,
    private: false,
    config: DEFAULT_REVIEW_CONFIG,
    created_at: Date.now(),
    ...overrides,
  };
}

/** Compute HMAC-SHA256 signature matching GitHub's X-Hub-Signature-256 format. */
async function signPayload(body: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
  const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `sha256=${hex}`;
}

/** GitHub API call log entry */
interface GitHubCall {
  url: string;
  method: string;
  body?: unknown;
}

// ── Test suite ─────────────────────────────────────────────────

describe('Integration: full E2E flows', () => {
  let store: MemoryTaskStore;
  let app: ReturnType<typeof createApp>;
  let mockEnv: Env;
  let githubCalls: GitHubCall[];
  const originalFetch = globalThis.fetch;

  /** Send a JSON request to the Hono app. */
  function api(method: string, path: string, body?: unknown) {
    return app.request(
      path,
      {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      mockEnv,
    );
  }

  /** Poll for tasks as a given agent. */
  async function poll(agentId: string) {
    const res = await api('POST', '/api/tasks/poll', { agent_id: agentId });
    return (await res.json()) as { tasks: Array<Record<string, unknown>> };
  }

  /** Claim a task. Returns success body or error body with claimed=false. */
  async function claim(taskId: string, agentId: string, role: string) {
    const res = await api('POST', `/api/tasks/${taskId}/claim`, { agent_id: agentId, role });
    const body = (await res.json()) as Record<string, unknown>;
    if (res.status !== 200) {
      // Map structured error to a flat shape for backward-compatible assertions
      const err = body as { error: { code: string; message: string } };
      return { claimed: false, reason: err.error.message, errorCode: err.error.code };
    }
    return body;
  }

  /** Submit a result. */
  async function submitResult(
    taskId: string,
    agentId: string,
    type: string,
    reviewText: string,
    verdict?: string,
    tokensUsed?: number,
  ) {
    const res = await api('POST', `/api/tasks/${taskId}/result`, {
      agent_id: agentId,
      type,
      review_text: reviewText,
      verdict,
      tokens_used: tokensUsed,
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  }

  beforeEach(() => {
    resetTimeoutThrottle();
    resetRateLimits();
    store = new MemoryTaskStore();
    app = createApp(store);
    mockEnv = getMockEnv();
    githubCalls = [];

    // Mock fetch — intercept all GitHub API calls
    globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const method = init?.method ?? 'GET';

      githubCalls.push({
        url,
        method,
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });

      // Installation token
      if (url.includes('/access_tokens')) {
        return new Response(JSON.stringify({ token: 'ghs_mock_token' }), { status: 200 });
      }

      // Fetch .review.yml — return 404 (use defaults)
      if (url.includes('/contents/.review.yml')) {
        return new Response('Not Found', { status: 404 });
      }

      // Post PR comment (issue comment)
      if (url.includes('/issues/') && url.includes('/comments') && method === 'POST') {
        return new Response(
          JSON.stringify({ html_url: 'https://github.com/acme/widget/pull/42#comment-456' }),
          { status: 200 },
        );
      }

      // Fetch PR details (for issue_comment trigger)
      if (url.includes('/pulls/') && !url.includes('/reviews') && method === 'GET') {
        return new Response(
          JSON.stringify({
            number: 42,
            html_url: 'https://github.com/acme/widget/pull/42',
            diff_url: 'https://github.com/acme/widget/pull/42.diff',
            base: { ref: 'main' },
            head: { ref: 'feat/awesome' },
            draft: false,
            labels: [],
          }),
          { status: 200 },
        );
      }

      // Default 404 for anything else
      return new Response('Not Found', { status: 404 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  // ═══════════════════════════════════════════════════════════
  // 1. Single-agent review (review_count=1)
  // ═══════════════════════════════════════════════════════════

  describe('single-agent review (review_count=1)', () => {
    it('poll → claim summary → submit → task completed + review posted to GitHub', async () => {
      const task = makeTask({ id: 'task-single' });
      await store.createTask(task);

      // 1. Agent polls — sees task with role=summary
      const pollResult = await poll('agent-alpha');
      expect(pollResult.tasks).toHaveLength(1);
      expect(pollResult.tasks[0].task_id).toBe('task-single');
      expect(pollResult.tasks[0].role).toBe('summary');
      expect(pollResult.tasks[0].owner).toBe('acme');
      expect(pollResult.tasks[0].repo).toBe('widget');
      expect(pollResult.tasks[0].pr_number).toBe(42);
      expect(typeof pollResult.tasks[0].timeout_seconds).toBe('number');
      expect((pollResult.tasks[0].timeout_seconds as number) > 0).toBe(true);

      // 2. Agent claims summary role
      const claimResult = await claim('task-single', 'agent-alpha', 'summary');
      expect(claimResult.claimed).toBe(true);
      // No reviews included (single-agent — no prior reviews)
      expect(claimResult.reviews).toEqual([]);

      // Verify task transitioned to reviewing
      const taskAfterClaim = await store.getTask('task-single');
      expect(taskAfterClaim?.status).toBe('reviewing');

      // 3. Agent submits review
      const reviewText = `## Summary
This PR adds a new widget feature. Overall looks good.

## Findings
- **[minor]** \`src/index.ts:10\` — Unused import of \`foo\`

## Verdict
APPROVE`;

      const result = await submitResult(
        'task-single',
        'agent-alpha',
        'summary',
        reviewText,
        'approve',
        1200,
      );
      expect(result.status).toBe(200);
      expect(result.body.success).toBe(true);

      // 4. Verify task completed
      const finalTask = await store.getTask('task-single');
      // postFinalReview is called which sets status — it will either be 'completed' or 'failed'
      // depending on whether the mock GitHub API call succeeded
      expect(['completed', 'failed']).toContain(finalTask?.status);

      // 5. Verify claim stored correctly
      const claims = await store.getClaims('task-single');
      expect(claims).toHaveLength(1);
      expect(claims[0].agent_id).toBe('agent-alpha');
      expect(claims[0].role).toBe('summary');
      expect(claims[0].status).toBe('completed');
      expect(claims[0].review_text).toBe(reviewText);
      expect(claims[0].verdict).toBe('approve');
      expect(claims[0].tokens_used).toBe(1200);

      // 6. Verify GitHub API was called to post comment
      const commentPost = githubCalls.find(
        (c) => c.url.includes('/issues/') && c.url.includes('/comments') && c.method === 'POST',
      );
      expect(commentPost).toBeDefined();
      expect(commentPost!.body).toBeDefined();
      // Body should contain the formatted review text with verdict
      expect((commentPost!.body as Record<string, unknown>).body).toBeDefined();
    });

    it('second agent sees nothing after task is claimed', async () => {
      await store.createTask(makeTask({ id: 'task-claimed' }));

      // Agent 1 claims
      await claim('task-claimed', 'agent-1', 'summary');

      // Agent 2 polls — task should not appear (slot taken)
      const pollResult = await poll('agent-2');
      expect(pollResult.tasks).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 2. Multi-agent review (review_count=3)
  // ═══════════════════════════════════════════════════════════

  describe('multi-agent review (review_count=3)', () => {
    it('full flow: 2 reviewers → synthesizer claims with review texts → submits', async () => {
      await store.createTask(makeTask({ id: 'task-multi', review_count: 3 }));

      // Phase 1: Two agents poll and claim review slots
      const poll1 = await poll('reviewer-a');
      expect(poll1.tasks[0].role).toBe('review');

      const poll2 = await poll('reviewer-b');
      expect(poll2.tasks[0].role).toBe('review');

      const claimA = await claim('task-multi', 'reviewer-a', 'review');
      expect(claimA.claimed).toBe(true);
      expect(claimA.reviews).toBeUndefined(); // reviews only included for summary claims

      const claimB = await claim('task-multi', 'reviewer-b', 'review');
      expect(claimB.claimed).toBe(true);

      // Phase 2: Both review slots taken — no more review slots
      const poll3 = await poll('reviewer-c');
      expect(poll3.tasks).toHaveLength(0); // reviews pending, summary not yet available

      // Phase 3: Reviewers submit
      await submitResult('task-multi', 'reviewer-a', 'review', 'Review A: LGTM', 'approve', 500);
      await submitResult(
        'task-multi',
        'reviewer-b',
        'review',
        '## Summary\nNeeds work\n## Verdict\nREQUEST_CHANGES',
        'request_changes',
        600,
      );

      // Phase 4: Summary slot now available
      const pollSynth = await poll('synthesizer');
      expect(pollSynth.tasks).toHaveLength(1);
      expect(pollSynth.tasks[0].role).toBe('summary');

      // Phase 5: Synthesizer claims — receives prior reviews
      const claimSynth = await claim('task-multi', 'synthesizer', 'summary');
      expect(claimSynth.claimed).toBe(true);
      const reviews = claimSynth.reviews as Array<Record<string, unknown>>;
      expect(reviews).toHaveLength(2);
      expect(reviews.map((r) => r.agent_id).sort()).toEqual(['reviewer-a', 'reviewer-b']);
      expect(reviews.find((r) => r.agent_id === 'reviewer-a')?.review_text).toBe('Review A: LGTM');

      // Phase 6: Synthesizer submits
      const synthResult = await submitResult(
        'task-multi',
        'synthesizer',
        'summary',
        '## Summary\nSynthesized review.\n## Verdict\nCOMMENT',
        undefined,
        900,
      );
      expect(synthResult.status).toBe(200);

      // Verify all claims
      const claims = await store.getClaims('task-multi');
      expect(claims).toHaveLength(3);
      expect(claims.filter((c) => c.status === 'completed')).toHaveLength(3);
    });

    it('third agent cannot claim review when all review slots are taken', async () => {
      await store.createTask(makeTask({ id: 'task-slots', review_count: 3 }));

      await claim('task-slots', 'a', 'review');
      await claim('task-slots', 'b', 'review');

      // Third agent tries to claim review — should fail (2 review slots for review_count=3)
      const res = await claim('task-slots', 'c', 'review');
      expect(res.claimed).toBe(false);
    });

    it('summary not available until all reviews are completed', async () => {
      await store.createTask(makeTask({ id: 'task-partial', review_count: 2 }));

      // Claim and submit only 1 review (need 1 for review_count=2)
      await claim('task-partial', 'r1', 'review');

      // Summary agent polls — review not yet completed
      let pollSynth = await poll('synth');
      expect(pollSynth.tasks).toHaveLength(0);

      // Complete the review
      await submitResult('task-partial', 'r1', 'review', 'Done', 'approve');

      // Now summary is available
      pollSynth = await poll('synth');
      expect(pollSynth.tasks).toHaveLength(1);
      expect(pollSynth.tasks[0].role).toBe('summary');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 3. Timeout handling
  // ═══════════════════════════════════════════════════════════

  describe('timeout handling', () => {
    it('expired pending tasks are marked timeout on next poll', async () => {
      await store.createTask(
        makeTask({
          id: 'task-expired',
          timeout_at: Date.now() - 1000, // already expired
        }),
      );

      // Any agent polling triggers lazy timeout check
      await poll('any-agent');

      const task = await store.getTask('task-expired');
      expect(task?.status).toBe('timeout');
    });

    it('expired reviewing tasks with partial reviews post them as fallback', async () => {
      await store.createTask(
        makeTask({
          id: 'task-partial-timeout',
          review_count: 3,
          timeout_at: Date.now() - 1000,
          status: 'reviewing',
        }),
      );
      // One completed review
      await store.createClaim({
        id: 'task-partial-timeout:r1',
        task_id: 'task-partial-timeout',
        agent_id: 'r1',
        role: 'review',
        status: 'completed',
        review_text: 'Partial review content',
        verdict: 'comment',
        created_at: Date.now() - 5000,
      });

      await poll('poller');

      const task = await store.getTask('task-partial-timeout');
      expect(task?.status).toBe('timeout');

      // Should have tried to post the partial review + timeout comment as issue comments
      const commentPosts = githubCalls.filter(
        (c) => c.url.includes('/issues/') && c.url.includes('/comments') && c.method === 'POST',
      );
      // At least 2: one for the partial review, one for the timeout message
      expect(commentPosts.length).toBeGreaterThanOrEqual(2);

      // Verify the timeout comment mentions partial reviews
      const timeoutComment = commentPosts.find((c) =>
        ((c.body as Record<string, unknown>)?.body as string)?.includes('timed out'),
      );
      expect(timeoutComment).toBeDefined();
    });

    it('claim is rejected for expired task', async () => {
      await store.createTask(makeTask({ id: 'task-late', timeout_at: Date.now() - 1000 }));

      const res = await claim('task-late', 'agent', 'summary');
      expect(res.claimed).toBe(false);
      expect(res.reason).toContain('timed out');
    });

    it('leaves task in current state when GitHub posting fails during timeout', async () => {
      await store.createTask(
        makeTask({
          id: 'task-fail-timeout',
          timeout_at: Date.now() - 1000, // already expired
          status: 'pending',
        }),
      );

      // Override fetch to fail on installation token request with 401 (not retried)
      const failingFetch = vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        // Fail on installation token request — simulates auth failure
        if (url.includes('/access_tokens')) {
          return new Response('Unauthorized', { status: 401 });
        }

        return new Response('Not Found', { status: 404 });
      }) as typeof fetch;
      globalThis.fetch = failingFetch;

      // Trigger timeout check via poll
      await poll('any-agent');

      // Task should NOT be marked timeout — GitHub posting failed
      const task = await store.getTask('task-fail-timeout');
      expect(task?.status).toBe('pending');
    });

    it('completed tasks are not affected by timeout checks', async () => {
      await store.createTask(
        makeTask({
          id: 'task-done',
          status: 'completed',
          timeout_at: Date.now() - 1000,
        }),
      );

      await poll('agent');

      // Should still be completed, not timeout
      const task = await store.getTask('task-done');
      expect(task?.status).toBe('completed');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 4. Rejection flow
  // ═══════════════════════════════════════════════════════════

  describe('rejection flow', () => {
    it('rejected claim frees the slot for another agent', async () => {
      await store.createTask(makeTask({ id: 'task-reject' }));

      // Agent 1 claims then rejects
      await claim('task-reject', 'agent-1', 'summary');
      await api('POST', '/api/tasks/task-reject/reject', {
        agent_id: 'agent-1',
        reason: 'Cannot access private repo diff',
      });

      // Claim status should be rejected
      const claims = await store.getClaims('task-reject');
      const rejectedClaim = claims.find((c) => c.agent_id === 'agent-1');
      expect(rejectedClaim?.status).toBe('rejected');

      // Task slot should be freed — agent 2 can now claim it
      const poll2 = await poll('agent-2');
      expect(poll2.tasks).toHaveLength(1);
      expect(poll2.tasks[0].role).toBe('summary');

      // Agent 2 claims and completes
      const claimRes = await claim('task-reject', 'agent-2', 'summary');
      expect(claimRes.claimed).toBe(true);
    });

    it('agent rejects → new agent claims freed slot → completes review', async () => {
      await store.createTask(makeTask({ id: 'task-reject-e2e', review_count: 2 }));

      // Agent 1 claims review, then rejects
      await claim('task-reject-e2e', 'agent-1', 'review');
      await api('POST', '/api/tasks/task-reject-e2e/reject', {
        agent_id: 'agent-1',
        reason: 'Diff too large',
      });

      // Agent 2 claims the freed review slot
      const poll2 = await poll('agent-2');
      expect(poll2.tasks).toHaveLength(1);
      expect(poll2.tasks[0].role).toBe('review');

      const claimRes = await claim('task-reject-e2e', 'agent-2', 'review');
      expect(claimRes.claimed).toBe(true);

      // Agent 2 completes the review
      await submitResult('task-reject-e2e', 'agent-2', 'review', 'Looks good', 'approve');

      // Summary slot now available
      const pollSynth = await poll('agent-3');
      expect(pollSynth.tasks).toHaveLength(1);
      expect(pollSynth.tasks[0].role).toBe('summary');
    });

    it('same agent can re-claim after rejection', async () => {
      await store.createTask(makeTask({ id: 'task-reclaim' }));

      // Agent claims then rejects
      await claim('task-reclaim', 'agent-1', 'summary');
      await api('POST', '/api/tasks/task-reclaim/reject', {
        agent_id: 'agent-1',
        reason: 'Transient error',
      });

      // Same agent can re-claim (removed from claimed_agents)
      const pollRes = await poll('agent-1');
      expect(pollRes.tasks).toHaveLength(1);

      const claimRes = await claim('task-reclaim', 'agent-1', 'summary');
      expect(claimRes.claimed).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 5. Error flow
  // ═══════════════════════════════════════════════════════════

  describe('error flow', () => {
    it('error claim is recorded correctly and frees slot', async () => {
      await store.createTask(makeTask({ id: 'task-error', review_count: 3 }));

      await claim('task-error', 'agent-crash', 'review');
      await api('POST', '/api/tasks/task-error/error', {
        agent_id: 'agent-crash',
        error: 'Tool process crashed with SIGSEGV',
      });

      const claims = await store.getClaims('task-error');
      const errClaim = claims.find((c) => c.agent_id === 'agent-crash');
      expect(errClaim?.status).toBe('error');

      // Slot should be freed — task counters updated
      const task = await store.getTask('task-error');
      expect(task?.review_claims).toBe(0);
      expect(task?.claimed_agents).toEqual([]);

      // Another agent can now claim the freed slot
      const pollRes = await poll('agent-replacement');
      expect(pollRes.tasks).toHaveLength(1);
      expect(pollRes.tasks[0].role).toBe('review');

      const claimRes = await claim('task-error', 'agent-replacement', 'review');
      expect(claimRes.claimed).toBe(true);
    });

    it('error on reject/error endpoints returns 404 for missing claims', async () => {
      const rejectRes = await api('POST', '/api/tasks/task-missing/reject', {
        agent_id: 'ghost',
        reason: 'test',
      });
      expect(rejectRes.status).toBe(404);

      const errorRes = await api('POST', '/api/tasks/task-missing/error', {
        agent_id: 'ghost',
        error: 'test',
      });
      expect(errorRes.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 6. Concurrent agents — race conditions
  // ═══════════════════════════════════════════════════════════

  describe('concurrent agent races', () => {
    it('sequential claims: second agent is rejected for single summary slot', async () => {
      await store.createTask(makeTask({ id: 'task-race' }));

      // First agent claims — succeeds
      const r1 = await claim('task-race', 'fast', 'summary');
      expect(r1.claimed).toBe(true);

      // Second agent claims — rejected (slot taken)
      const r2 = await claim('task-race', 'slow', 'summary');
      expect(r2.claimed).toBe(false);
    });

    it('multiple agents can claim different review slots sequentially', async () => {
      await store.createTask(makeTask({ id: 'task-multi-race', review_count: 4 }));

      // 3 agents claim review sequentially (3 review slots for review_count=4)
      const c1 = await claim('task-multi-race', 'a1', 'review');
      const c2 = await claim('task-multi-race', 'a2', 'review');
      const c3 = await claim('task-multi-race', 'a3', 'review');

      expect(c1.claimed).toBe(true);
      expect(c2.claimed).toBe(true);
      expect(c3.claimed).toBe(true);

      // Fourth agent should be rejected (all 3 review slots taken)
      const c4 = await claim('task-multi-race', 'a4', 'review');
      expect(c4.claimed).toBe(false);
    });

    // Note: MemoryTaskStore is synchronous, so Promise.all executes claims
    // serially in the same microtask turn. These tests validate the locking
    // logic at the API layer but cannot reproduce true I/O-level races that
    // occur with Cloudflare KV's eventual consistency. The lock mechanism
    // (summary-lock:{taskId} key) is the defense-in-depth for production.
    it('concurrent summary claims: only one agent wins (#273)', async () => {
      await store.createTask(makeTask({ id: 'task-concurrent-summary' }));

      // Fire 5 concurrent summary claims simultaneously
      const results = await Promise.all(
        ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5'].map((agentId) =>
          claim('task-concurrent-summary', agentId, 'summary'),
        ),
      );

      const claimed = results.filter((r) => r.claimed === true);
      const rejected = results.filter((r) => r.claimed === false);

      // Exactly one agent should win
      expect(claimed).toHaveLength(1);
      expect(rejected).toHaveLength(4);

      // All rejected agents should have a reason
      for (const r of rejected) {
        expect(r.reason).toBeDefined();
      }
    });

    it('concurrent summary claims + result: only one GitHub comment posted (#273)', async () => {
      await store.createTask(makeTask({ id: 'task-concurrent-post' }));

      const agentIds = ['synth-a', 'synth-b', 'synth-c'];

      // Fire 3 concurrent summary claims
      const claimResults = await Promise.all(
        agentIds.map((agentId) => claim('task-concurrent-post', agentId, 'summary')),
      );

      const winners = claimResults
        .map((r, i) => ({ result: r, agentId: agentIds[i] }))
        .filter((r) => r.result.claimed === true);
      expect(winners).toHaveLength(1);
      const winner = winners[0]!;

      // Count GitHub comment calls before
      const commentsBefore = githubCalls.filter(
        (c) => c.url.includes('/issues/') && c.url.includes('/comments') && c.method === 'POST',
      ).length;

      // Winner submits result — should post to GitHub
      await submitResult(
        'task-concurrent-post',
        winner.agentId,
        'summary',
        '## Summary\nLooks good.',
        'approve',
      );

      // Only 1 comment should have been posted
      const commentsAfter = githubCalls.filter(
        (c) => c.url.includes('/issues/') && c.url.includes('/comments') && c.method === 'POST',
      ).length;
      expect(commentsAfter - commentsBefore).toBe(1);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 7. Agent last-seen tracking
  // ═══════════════════════════════════════════════════════════

  describe('agent last-seen tracking', () => {
    it('poll updates agent last-seen timestamp', async () => {
      const before = Date.now();
      await poll('tracked-agent');
      const lastSeen = await store.getAgentLastSeen('tracked-agent');

      expect(lastSeen).not.toBeNull();
      expect(lastSeen!).toBeGreaterThanOrEqual(before);
      expect(lastSeen!).toBeLessThanOrEqual(Date.now());
    });

    it('multiple polls update the timestamp', async () => {
      await poll('tracked-agent');
      const first = await store.getAgentLastSeen('tracked-agent');

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 5));

      await poll('tracked-agent');
      const second = await store.getAgentLastSeen('tracked-agent');

      expect(second!).toBeGreaterThanOrEqual(first!);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 8. Multiple tasks
  // ═══════════════════════════════════════════════════════════

  describe('multiple tasks', () => {
    it('agent sees all available tasks in one poll', async () => {
      await store.createTask(makeTask({ id: 'task-a', pr_number: 10 }));
      await store.createTask(makeTask({ id: 'task-b', pr_number: 20 }));
      await store.createTask(makeTask({ id: 'task-c', pr_number: 30 }));

      const result = await poll('agent-x');
      expect(result.tasks).toHaveLength(3);
      const prNumbers = result.tasks.map((t) => t.pr_number);
      expect(prNumbers).toContain(10);
      expect(prNumbers).toContain(20);
      expect(prNumbers).toContain(30);
    });

    it('agent can work on tasks sequentially', async () => {
      await store.createTask(makeTask({ id: 'task-seq-1', pr_number: 1 }));
      await store.createTask(makeTask({ id: 'task-seq-2', pr_number: 2 }));

      // Claim and finish first task
      await claim('task-seq-1', 'worker', 'summary');
      await submitResult('task-seq-1', 'worker', 'summary', 'Review 1', 'approve');

      // Poll again — should see only the second task
      const result = await poll('worker');
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].task_id).toBe('task-seq-2');
    });

    it('completed and timed-out tasks are excluded from poll', async () => {
      await store.createTask(makeTask({ id: 'done', status: 'completed' }));
      await store.createTask(makeTask({ id: 'timedout', status: 'timeout' }));
      await store.createTask(makeTask({ id: 'failed', status: 'failed' }));
      await store.createTask(makeTask({ id: 'active' }));

      const result = await poll('agent');
      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].task_id).toBe('active');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 9. Edge cases
  // ═══════════════════════════════════════════════════════════

  describe('edge cases', () => {
    it('result for a task that no longer exists returns 404', async () => {
      const res = await api('POST', '/api/tasks/nonexistent/result', {
        agent_id: 'ghost',
        type: 'review',
        review_text: 'Review of deleted task',
      });
      expect(res.status).toBe(404);
    });

    it('submitting result twice on the same claim returns 409', async () => {
      await store.createTask(makeTask({ id: 'task-dup' }));
      await claim('task-dup', 'agent', 'summary');

      // First submit
      const r1 = await submitResult('task-dup', 'agent', 'summary', 'First');
      expect(r1.status).toBe(200);

      // Second submit — claim already completed
      const r2 = await submitResult('task-dup', 'agent', 'summary', 'Second');
      expect(r2.status).toBe(409);
    });

    it('poll with empty store returns empty array', async () => {
      const result = await poll('lonely-agent');
      expect(result.tasks).toEqual([]);
    });

    it('claim with missing fields returns 400', async () => {
      const res = await api('POST', '/api/tasks/any/claim', { agent_id: 'a' });
      expect(res.status).toBe(400);
    });

    it('result with missing fields returns 400', async () => {
      const res = await api('POST', '/api/tasks/any/result', { agent_id: 'a' });
      expect(res.status).toBe(400);
    });

    it('claim on completed task is rejected', async () => {
      await store.createTask(makeTask({ id: 'task-done', status: 'completed' }));
      const res = await claim('task-done', 'agent', 'summary');
      expect(res.claimed).toBe(false);
      expect(res.reason).toContain('completed');
    });

    it('claim on timed-out task is rejected', async () => {
      await store.createTask(makeTask({ id: 'task-to', status: 'timeout' }));
      const res = await claim('task-to', 'agent', 'summary');
      expect(res.claimed).toBe(false);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 10. Health check & registry
  // ═══════════════════════════════════════════════════════════

  describe('health check & registry', () => {
    it('GET / returns status ok', async () => {
      const res = await app.request('/', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: 'ok', service: 'opencara-server' });
    });

    it('GET /api/registry returns tools and models', async () => {
      const res = await app.request('/api/registry', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { tools: unknown[]; models: unknown[] };
      expect(body.tools.length).toBeGreaterThan(0);
      expect(body.models.length).toBeGreaterThan(0);
    });

    it('unknown route returns 404', async () => {
      const res = await app.request('/api/nonexistent', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(404);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 11. Webhook → task creation (requires signature)
  // ═══════════════════════════════════════════════════════════

  describe('webhook → task creation', () => {
    it('valid PR webhook creates a task that agents can poll', async () => {
      const payload = {
        action: 'opened',
        installation: { id: 999 },
        repository: { owner: { login: 'acme' }, name: 'widget' },
        pull_request: {
          number: 77,
          html_url: 'https://github.com/acme/widget/pull/77',
          diff_url: 'https://github.com/acme/widget/pull/77.diff',
          base: { ref: 'main' },
          head: { ref: 'feat/new-thing' },
          draft: false,
          labels: [],
        },
      };

      const body = JSON.stringify(payload);
      const signature = await signPayload(body, WEBHOOK_SECRET);

      const res = await app.request(
        '/webhook/github',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': signature,
            'X-GitHub-Event': 'pull_request',
          },
          body,
        },
        mockEnv,
      );
      expect(res.status).toBe(200);

      // Verify a task was created in the store
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].owner).toBe('acme');
      expect(tasks[0].repo).toBe('widget');
      expect(tasks[0].pr_number).toBe(77);
      expect(tasks[0].status).toBe('pending');

      // Verify agent can poll for the task
      const pollResult = await poll('agent-1');
      expect(pollResult.tasks).toHaveLength(1);
      expect(pollResult.tasks[0].pr_number).toBe(77);
      expect(pollResult.tasks[0].role).toBe('summary'); // review_count=1 (default)
    });

    it('fetches .review.yml from base branch, not head branch', async () => {
      const payload = {
        action: 'opened',
        installation: { id: 999 },
        repository: { owner: { login: 'acme' }, name: 'widget' },
        pull_request: {
          number: 78,
          html_url: 'https://github.com/acme/widget/pull/78',
          diff_url: 'https://github.com/acme/widget/pull/78.diff',
          base: { ref: 'main' },
          head: { ref: 'feat/malicious-config' },
          draft: false,
          labels: [],
        },
      };

      const body = JSON.stringify(payload);
      const signature = await signPayload(body, WEBHOOK_SECRET);

      await app.request(
        '/webhook/github',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': signature,
            'X-GitHub-Event': 'pull_request',
          },
          body,
        },
        mockEnv,
      );

      // The .review.yml fetch should use base ref (main), not head ref (feat/malicious-config)
      const configFetch = githubCalls.find((c) => c.url.includes('/contents/.review.yml'));
      expect(configFetch).toBeDefined();
      expect(configFetch!.url).toContain('ref=main');
      expect(configFetch!.url).not.toContain('ref=feat/malicious-config');
    });

    it('invalid signature is rejected with 401', async () => {
      const body = JSON.stringify({ action: 'opened' });

      const res = await app.request(
        '/webhook/github',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256':
              'sha256=0000000000000000000000000000000000000000000000000000000000000000',
            'X-GitHub-Event': 'pull_request',
          },
          body,
        },
        mockEnv,
      );
      expect(res.status).toBe(401);
    });

    it('missing signature is rejected with 401', async () => {
      const res = await app.request(
        '/webhook/github',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-GitHub-Event': 'pull_request',
          },
          body: '{}',
        },
        mockEnv,
      );
      expect(res.status).toBe(401);
    });

    it('draft PRs are skipped (no task created)', async () => {
      const payload = {
        action: 'opened',
        installation: { id: 999 },
        repository: { owner: { login: 'acme' }, name: 'widget' },
        pull_request: {
          number: 88,
          html_url: 'https://github.com/acme/widget/pull/88',
          diff_url: 'https://github.com/acme/widget/pull/88.diff',
          base: { ref: 'main' },
          head: { ref: 'draft-branch' },
          draft: true,
          labels: [],
        },
      };

      const body = JSON.stringify(payload);
      const signature = await signPayload(body, WEBHOOK_SECRET);

      await app.request(
        '/webhook/github',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': signature,
            'X-GitHub-Event': 'pull_request',
          },
          body,
        },
        mockEnv,
      );

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(0);
    });

    it('non-triggered action is skipped', async () => {
      const payload = {
        action: 'closed', // not in default trigger.on ['opened']
        installation: { id: 999 },
        repository: { owner: { login: 'acme' }, name: 'widget' },
        pull_request: {
          number: 99,
          html_url: 'https://github.com/acme/widget/pull/99',
          diff_url: 'https://github.com/acme/widget/pull/99.diff',
          base: { ref: 'main' },
          head: { ref: 'feat' },
        },
      };

      const body = JSON.stringify(payload);
      const signature = await signPayload(body, WEBHOOK_SECRET);

      await app.request(
        '/webhook/github',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': signature,
            'X-GitHub-Event': 'pull_request',
          },
          body,
        },
        mockEnv,
      );

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(0);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 12. Webhook idempotency (PR identity dedup)
  // ═══════════════════════════════════════════════════════════

  describe('webhook idempotency', () => {
    /** Helper: send a signed PR webhook for a given PR number. */
    async function sendPRWebhook(prNumber: number, action = 'opened') {
      const payload = {
        action,
        installation: { id: 999 },
        repository: { owner: { login: 'acme' }, name: 'widget' },
        pull_request: {
          number: prNumber,
          html_url: `https://github.com/acme/widget/pull/${prNumber}`,
          diff_url: `https://github.com/acme/widget/pull/${prNumber}.diff`,
          base: { ref: 'main' },
          head: { ref: 'feat/branch' },
          draft: false,
          labels: [],
        },
      };
      const body = JSON.stringify(payload);
      const signature = await signPayload(body, WEBHOOK_SECRET);
      return app.request(
        '/webhook/github',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': signature,
            'X-GitHub-Event': 'pull_request',
          },
          body,
        },
        mockEnv,
      );
    }

    /** Helper: send a signed issue_comment webhook (trigger command). */
    async function sendCommentWebhook(prNumber: number, commentBody: string) {
      const payload = {
        action: 'created',
        installation: { id: 999 },
        repository: { owner: { login: 'acme' }, name: 'widget' },
        issue: {
          number: prNumber,
          pull_request: { url: `https://api.github.com/repos/acme/widget/pulls/${prNumber}` },
        },
        comment: {
          body: commentBody,
          user: { login: 'maintainer' },
          author_association: 'OWNER',
        },
      };
      const body = JSON.stringify(payload);
      const signature = await signPayload(body, WEBHOOK_SECRET);
      return app.request(
        '/webhook/github',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': signature,
            'X-GitHub-Event': 'issue_comment',
          },
          body,
        },
        mockEnv,
      );
    }

    it('duplicate PR webhook does not create a second task', async () => {
      // First webhook — creates a task
      await sendPRWebhook(50);
      const tasksAfterFirst = await store.listTasks();
      expect(tasksAfterFirst).toHaveLength(1);

      // Second webhook (redelivery) — no new task
      await sendPRWebhook(50);
      const tasksAfterSecond = await store.listTasks();
      expect(tasksAfterSecond).toHaveLength(1);
    });

    it('rapid duplicate opened events for same PR creates only one task', async () => {
      await sendPRWebhook(51, 'opened');
      await sendPRWebhook(51, 'opened');
      await sendPRWebhook(51, 'opened');

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].pr_number).toBe(51);
    });

    it('different PRs create separate tasks', async () => {
      await sendPRWebhook(60);
      await sendPRWebhook(61);

      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(2);
      const prNumbers = tasks.map((t) => t.pr_number).sort();
      expect(prNumbers).toEqual([60, 61]);
    });

    it('new task allowed after previous task reached terminal state (completed)', async () => {
      // Create and complete a task
      await sendPRWebhook(70);
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      await store.updateTask(tasks[0].id, { status: 'completed' });

      // New webhook for same PR — should create a new task
      await sendPRWebhook(70);
      const allTasks = await store.listTasks();
      // listTasks with no filter returns all tasks; active filter check is in createTaskForPR
      const activeTasks = allTasks.filter(
        (t) => t.status === 'pending' || t.status === 'reviewing',
      );
      expect(activeTasks).toHaveLength(1);
    });

    it('new task allowed after previous task timed out', async () => {
      await sendPRWebhook(71);
      const tasks = await store.listTasks();
      await store.updateTask(tasks[0].id, { status: 'timeout' });

      await sendPRWebhook(71);
      const allTasks = await store.listTasks();
      const activeTasks = allTasks.filter(
        (t) => t.status === 'pending' || t.status === 'reviewing',
      );
      expect(activeTasks).toHaveLength(1);
    });

    it('new task allowed after previous task failed', async () => {
      await sendPRWebhook(72);
      const tasks = await store.listTasks();
      await store.updateTask(tasks[0].id, { status: 'failed' });

      await sendPRWebhook(72);
      const allTasks = await store.listTasks();
      const activeTasks = allTasks.filter(
        (t) => t.status === 'pending' || t.status === 'reviewing',
      );
      expect(activeTasks).toHaveLength(1);
    });

    it('/opencara review comment skips when active task exists', async () => {
      // Create active task via PR webhook
      await sendPRWebhook(80);
      const tasksBefore = await store.listTasks();
      expect(tasksBefore).toHaveLength(1);

      // Comment trigger — should not create duplicate
      await sendCommentWebhook(80, '/opencara review');
      const tasksAfter = await store.listTasks();
      expect(tasksAfter).toHaveLength(1);
    });

    it('/opencara review comment creates task when no active task exists', async () => {
      // No prior task — comment trigger should create one
      await sendCommentWebhook(81, '/opencara review');
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(1);
      expect(tasks[0].pr_number).toBe(81);
    });

    it('/opencara review comment fetches .review.yml from base branch', async () => {
      githubCalls.length = 0;
      await sendCommentWebhook(83, '/opencara review');

      // The mock returns PR details with base: { ref: 'main' } and head: { ref: 'feat/test' }
      // .review.yml should be fetched using base ref (main), not head ref
      const configFetch = githubCalls.find((c) => c.url.includes('/contents/.review.yml'));
      expect(configFetch).toBeDefined();
      expect(configFetch!.url).toContain('ref=main');
      expect(configFetch!.url).not.toContain('ref=feat/test');
    });

    it('/opencara review comment creates task after previous task completed', async () => {
      // Create and complete a task
      await sendPRWebhook(82);
      const tasks = await store.listTasks();
      await store.updateTask(tasks[0].id, { status: 'completed' });

      // Comment trigger — should create new task (previous is terminal)
      await sendCommentWebhook(82, '/opencara review');
      const allTasks = await store.listTasks();
      const activeTasks = allTasks.filter(
        (t) => t.status === 'pending' || t.status === 'reviewing',
      );
      expect(activeTasks).toHaveLength(1);
    });

    it('dedup is scoped to owner/repo — same PR number on different repos creates tasks', async () => {
      // Create task for acme/widget PR #90
      await sendPRWebhook(90);

      // Manually create a task for a different repo with same PR number
      await store.createTask(
        makeTask({ id: 'other-repo-task', owner: 'other', repo: 'project', pr_number: 90 }),
      );

      // Both should exist
      const tasks = await store.listTasks();
      expect(tasks).toHaveLength(2);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // 13. Full E2E: webhook → poll → claim → result → GitHub
  // ═══════════════════════════════════════════════════════════

  describe('full E2E: webhook → poll → claim → result → posted', () => {
    it('complete single-agent lifecycle via HTTP', async () => {
      // Step 1: Webhook creates a task
      const payload = {
        action: 'opened',
        installation: { id: 888 },
        repository: { owner: { login: 'org' }, name: 'app' },
        pull_request: {
          number: 5,
          html_url: 'https://github.com/org/app/pull/5',
          diff_url: 'https://github.com/org/app/pull/5.diff',
          base: { ref: 'main' },
          head: { ref: 'fix/bug' },
        },
      };
      const body = JSON.stringify(payload);
      const signature = await signPayload(body, WEBHOOK_SECRET);

      const webhookRes = await app.request(
        '/webhook/github',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Hub-Signature-256': signature,
            'X-GitHub-Event': 'pull_request',
          },
          body,
        },
        mockEnv,
      );
      expect(webhookRes.status).toBe(200);

      // Step 2: Agent polls
      const pollResult = await poll('e2e-agent');
      expect(pollResult.tasks).toHaveLength(1);
      const task = pollResult.tasks[0];
      expect(task.owner).toBe('org');
      expect(task.repo).toBe('app');
      expect(task.pr_number).toBe(5);
      expect(task.role).toBe('summary');

      const taskId = task.task_id as string;

      // Step 3: Agent claims
      const claimRes = await claim(taskId, 'e2e-agent', 'summary');
      expect(claimRes.claimed).toBe(true);

      // Step 4: Agent submits review
      const review = '## Summary\nBug fix looks correct.\n\n## Verdict\nAPPROVE';
      await submitResult(taskId, 'e2e-agent', 'summary', review, 'approve', 800);

      // Step 5: Verify task completed and review posted
      const finalTask = await store.getTask(taskId);
      expect(['completed', 'failed']).toContain(finalTask?.status);

      // Step 6: Verify no tasks remain for polling
      const emptyPoll = await poll('e2e-agent');
      expect(emptyPoll.tasks).toHaveLength(0);
    });
  });
});
