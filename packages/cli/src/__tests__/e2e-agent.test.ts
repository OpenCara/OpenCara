/**
 * E2E tests for the CLI agent — runs startAgent() against a real Hono server
 * (in-memory) with a mocked tool executor.
 *
 * Fake Server: real Hono app + MemoryTaskStore, accessed via fetch interception
 * Fake Tool: vi.mock() on tool-executor.js returns canned review output
 *
 * Note: tests that submit summary results trigger server-side postFinalReview
 * which uses crypto.subtle (doesn't resolve with fake timers). These tests
 * verify claim status only, not task final status.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startAgent, type ConsumptionDeps } from '../commands/agent.js';
import type { ReviewExecutorDeps } from '../review.js';
import { createSessionTracker } from '../consumption.js';
import { FakeServer, FAKE_SERVER_URL } from './helpers/fake-server.js';
import { executeTool } from '../tool-executor.js';

// ── Mock tool executor ───────────────────────────────────────

vi.mock('../tool-executor.js', () => ({
  executeTool: vi.fn(async () => ({
    stdout:
      '## Summary\nLooks good. No issues found.\n\n## Findings\nNo issues found.\n\n## Verdict\nAPPROVE',
    stderr: '',
    exitCode: 0,
    tokensUsed: 500,
    tokensParsed: true,
  })),
  estimateTokens: (text: string) => Math.ceil(text.length / 4),
  validateCommandBinary: () => true,
  parseCommandTemplate: (cmd: string) => cmd.split(' '),
}));

const mockedExecuteTool = vi.mocked(executeTool);

// ── Helpers ──────────────────────────────────────────────────

function makeDeps(agentId = 'test-agent'): {
  reviewDeps: ReviewExecutorDeps;
  consumptionDeps: ConsumptionDeps;
} {
  const session = createSessionTracker();
  return {
    reviewDeps: { commandTemplate: 'echo test', maxDiffSizeKb: 500 },
    consumptionDeps: { agentId, limits: null, session },
  };
}

async function advanceTime(totalMs: number, stepMs = 100): Promise<void> {
  const steps = Math.ceil(totalMs / stepMs);
  for (let i = 0; i < steps; i++) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
}

async function stopAgent(promise: Promise<void>, server: FakeServer): Promise<void> {
  server.uninstallFetch();
  globalThis.fetch = vi.fn().mockResolvedValue({
    ok: false,
    status: 401,
    json: () => Promise.resolve({ error: 'shutdown' }),
  });
  await advanceTime(3000);
  await promise;
}

// ── Test Suite ───────────────────────────────────────────────

describe('E2E Agent Scenarios', () => {
  let server: FakeServer;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(process, 'on').mockImplementation(() => process);

    server = new FakeServer();
    server.install();

    mockedExecuteTool.mockResolvedValue({
      stdout:
        '## Summary\nLooks good. No issues found.\n\n## Findings\nNo issues found.\n\n## Verdict\nAPPROVE',
      stderr: '',
      exitCode: 0,
      tokensUsed: 500,
      tokensParsed: true,
    });
  });

  afterEach(() => {
    server.restore();
    vi.useRealTimers();
  });

  function startTestAgent(
    agentId: string,
    opts?: { reviewOnly?: boolean; maxDiffSizeKb?: number },
  ): Promise<void> {
    const deps = makeDeps(agentId);
    const reviewDeps = opts?.maxDiffSizeKb
      ? { ...deps.reviewDeps, maxDiffSizeKb: opts.maxDiffSizeKb }
      : deps.reviewDeps;

    return startAgent(
      agentId,
      FAKE_SERVER_URL,
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      deps.consumptionDeps,
      { pollIntervalMs: 100, reviewOnly: opts?.reviewOnly },
    );
  }

  // ═══════════════════════════════════════════════════════════
  // A. Single-Agent Review (review role, no postFinalReview)
  // ═══════════════════════════════════════════════════════════

  describe('A. Single-agent review lifecycle', () => {
    it('poll → claim review → tool runs → submit → claim completed', async () => {
      // Use review_count=2 so the agent gets a 'review' role (not summary).
      // Review submissions don't trigger postFinalReview (no crypto.subtle).
      const taskId = await server.injectTask({ reviewCount: 2 });

      const agentPromise = startTestAgent('agent-1');
      await advanceTime(500);

      // Verify claim was created and completed
      const claims = await server.getClaims(taskId);
      expect(claims).toHaveLength(1);
      expect(claims[0].agent_id).toBe('agent-1');
      expect(claims[0].role).toBe('review');
      expect(claims[0].status).toBe('completed');
      expect(claims[0].review_text).toBeDefined();
      expect(claims[0].model).toBe('test-model');
      expect(claims[0].tool).toBe('test-tool');

      // Tool was called
      expect(mockedExecuteTool).toHaveBeenCalled();

      // Task should have completed_reviews incremented
      const task = await server.getTask(taskId);
      expect(task?.completed_reviews).toBe(1);

      await stopAgent(agentPromise, server);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // B. Multi-Agent Review Flow
  // ═══════════════════════════════════════════════════════════

  describe('B. Multi-agent review flow', () => {
    it('two agents claim review slots → both submit successfully', async () => {
      const taskId = await server.injectTask({ reviewCount: 3 });

      // First agent claims and completes review
      const agent1Promise = startTestAgent('reviewer-1');
      await advanceTime(500);

      let claims = await server.getClaims(taskId);
      expect(claims).toHaveLength(1);
      expect(claims[0].role).toBe('review');
      expect(claims[0].status).toBe('completed');

      await stopAgent(agent1Promise, server);
      server.install();

      // Second agent claims and completes review
      const agent2Promise = startTestAgent('reviewer-2');
      await advanceTime(500);

      claims = await server.getClaims(taskId);
      expect(claims).toHaveLength(2);
      const r2 = claims.find((c) => c.agent_id === 'reviewer-2');
      expect(r2).toBeDefined();
      expect(r2!.role).toBe('review');
      expect(r2!.status).toBe('completed');

      // Task should have both reviews counted
      const task = await server.getTask(taskId);
      expect(task?.completed_reviews).toBe(2);

      // Summary should now be available for the next agent
      // (we don't test summary submission here to avoid crypto.subtle issues)

      await stopAgent(agent2Promise, server);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // C. Diff Fetch Failure → Rejection
  // ═══════════════════════════════════════════════════════════

  describe('C. Diff fetch failure → rejection', () => {
    it('diff URL returns 500 → agent rejects task on server', async () => {
      await server.injectTask();
      server.diffFetchError = true;

      const agentPromise = startTestAgent('agent-diff-fail');
      await advanceTime(3000);

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Failed to fetch diff'));
      expect(mockedExecuteTool).not.toHaveBeenCalled();

      await stopAgent(agentPromise, server);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // D. Tool Execution Failure → Error
  // ═══════════════════════════════════════════════════════════

  describe('D. Tool execution failure → error', () => {
    it('tool throws → agent reports error to server', async () => {
      const taskId = await server.injectTask({ reviewCount: 2 }); // review role
      mockedExecuteTool.mockRejectedValue(new Error('Tool crashed with SIGSEGV'));

      const agentPromise = startTestAgent('agent-crash');
      await advanceTime(3000);

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error on task'));

      // Mark task completed to stop re-claim loop
      await server.store.updateTask(taskId, { status: 'completed' });

      await stopAgent(agentPromise, server);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // E. Claim Rejected → Agent Skips
  // ═══════════════════════════════════════════════════════════

  describe('E. Claim rejected → skip', () => {
    it('no available slots → agent keeps polling without claiming', async () => {
      const taskId = await server.injectTask();

      await server.store.updateTask(taskId, {
        claimed_agents: ['other-agent'],
        summary_claimed: true,
        status: 'reviewing',
      });
      await server.store.createClaim({
        id: `${taskId}:other-agent`,
        task_id: taskId,
        agent_id: 'other-agent',
        role: 'summary',
        status: 'pending',
        created_at: Date.now(),
      });

      const agentPromise = startTestAgent('late-agent');
      await advanceTime(500);

      expect(mockedExecuteTool).not.toHaveBeenCalled();

      await stopAgent(agentPromise, server);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // F. review_only Filtering
  // ═══════════════════════════════════════════════════════════

  describe('F. review_only filtering', () => {
    it('agent with reviewOnly skips summary-only tasks', async () => {
      await server.injectTask({ reviewCount: 1 });

      const agentPromise = startTestAgent('review-only-agent', { reviewOnly: true });
      await advanceTime(500);

      expect(mockedExecuteTool).not.toHaveBeenCalled();

      await stopAgent(agentPromise, server);
    });

    it('agent with reviewOnly picks up review tasks', async () => {
      const taskId = await server.injectTask({ reviewCount: 3 });

      const agentPromise = startTestAgent('review-only-agent', { reviewOnly: true });
      await advanceTime(500);

      const claims = await server.getClaims(taskId);
      expect(claims).toHaveLength(1);
      expect(claims[0].role).toBe('review');
      expect(claims[0].status).toBe('completed');

      await stopAgent(agentPromise, server);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // G. Diff Too Large → Rejection
  // ═══════════════════════════════════════════════════════════

  describe('G. Diff too large → rejection', () => {
    it('diff exceeds maxDiffSizeKb → agent rejects task', async () => {
      const taskId = await server.injectTask({ reviewCount: 2 }); // review role
      server.diffContent = 'x'.repeat(2 * 1024); // 2KB

      const agentPromise = startTestAgent('agent-big-diff', { maxDiffSizeKb: 1 });
      await advanceTime(3000);

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Diff too large'));
      expect(mockedExecuteTool).not.toHaveBeenCalled();

      await server.store.updateTask(taskId, { status: 'completed' });

      await stopAgent(agentPromise, server);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // H. Graceful Shutdown
  // ═══════════════════════════════════════════════════════════

  describe('H. Graceful shutdown via auth failure', () => {
    it('agent stops after 3 consecutive auth failures', async () => {
      server.uninstallFetch();
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'Unauthorized' }),
      });

      const deps = makeDeps('graceful-agent');
      const agentPromise = startAgent(
        'graceful-agent',
        FAKE_SERVER_URL,
        { model: 'test-model', tool: 'test-tool' },
        deps.reviewDeps,
        deps.consumptionDeps,
        { pollIntervalMs: 100 },
      );

      await advanceTime(2000);
      await agentPromise;

      expect(console.error).toHaveBeenCalledWith('Authentication failed repeatedly. Exiting.');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // I. Summary Type Mismatch Bug (documents known issue)
  // ═══════════════════════════════════════════════════════════

  describe('I. Summary type mismatch bug (single-agent mode)', () => {
    it('single-agent: summary claim with empty reviews → type mismatch error', async () => {
      // In single-agent mode (review_count=1), the agent claims 'summary'.
      // Server returns empty reviews. executeSummaryTask falls back to
      // executeReviewTask, which submits type: 'review'. But the claim role
      // is 'summary' — server rejects with 400 (type mismatch).
      const taskId = await server.injectTask({ reviewCount: 1 });

      const agentPromise = startTestAgent('single-agent');
      await advanceTime(3000);

      // Tool was called (review execution happened)
      expect(mockedExecuteTool).toHaveBeenCalled();

      // The type mismatch error was logged
      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining("does not match submission type 'review'"),
      );

      await server.store.updateTask(taskId, { status: 'completed' });
      await stopAgent(agentPromise, server);
    });
  });
});
