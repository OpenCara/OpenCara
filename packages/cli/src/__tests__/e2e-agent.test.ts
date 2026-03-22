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
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  testCommand: vi.fn(async () => ({ ok: true, elapsedMs: 100 })),
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
    consumptionDeps: { agentId, session },
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
    json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'shutdown' } }),
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

    mockedExecuteTool.mockReset();
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
    opts?: {
      reviewOnly?: boolean;
      maxDiffSizeKb?: number;
      repoConfig?: import('@opencara/shared').RepoConfig;
    },
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
      { pollIntervalMs: 100, reviewOnly: opts?.reviewOnly, repoConfig: opts?.repoConfig },
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
        status: 'reviewing',
      });
      await server.store.acquireLock(`summary:${taskId}`, 'other-agent');
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

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Authentication failed repeatedly. Exiting.'),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════
  // I. Repo Filtering
  // ═══════════════════════════════════════════════════════════

  describe('I. Repo filtering', () => {
    it('agent with repo whitelist skips tasks for non-matching repos', async () => {
      // Default task is for owner=acme, repo=widget
      await server.injectTask({ reviewCount: 2 });

      const agentPromise = startTestAgent('filtered-agent', {
        repoConfig: { mode: 'whitelist', list: ['other/repo'] },
      });
      await advanceTime(500);

      // Agent should not have claimed anything — repo doesn't match
      expect(mockedExecuteTool).not.toHaveBeenCalled();

      await stopAgent(agentPromise, server);
    });

    it('agent with repo whitelist picks up matching tasks', async () => {
      const taskId = await server.injectTask({ reviewCount: 2 });

      const agentPromise = startTestAgent('filtered-agent', {
        repoConfig: { mode: 'whitelist', list: ['test-org/test-repo'] },
      });
      await advanceTime(500);

      const claims = await server.getClaims(taskId);
      expect(claims).toHaveLength(1);
      expect(claims[0].status).toBe('completed');

      await stopAgent(agentPromise, server);
    });

    it('agent with repo blacklist skips blacklisted repos', async () => {
      await server.injectTask({ reviewCount: 2 });

      const agentPromise = startTestAgent('filtered-agent', {
        repoConfig: { mode: 'blacklist', list: ['test-org/test-repo'] },
      });
      await advanceTime(500);

      expect(mockedExecuteTool).not.toHaveBeenCalled();

      await stopAgent(agentPromise, server);
    });

    it('agent with mode=all picks up any task', async () => {
      const taskId = await server.injectTask({ reviewCount: 2 });

      const agentPromise = startTestAgent('all-agent', {
        repoConfig: { mode: 'all' },
      });
      await advanceTime(500);

      const claims = await server.getClaims(taskId);
      expect(claims).toHaveLength(1);
      expect(claims[0].status).toBe('completed');

      await stopAgent(agentPromise, server);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // J. Single-agent mode: summary claim with empty reviews
  // ═══════════════════════════════════════════════════════════

  describe('I. Single-agent mode (review_count=1)', () => {
    it('single-agent: summary claim with empty reviews → submits as summary', async () => {
      // In single-agent mode (review_count=1), the agent claims 'summary'.
      // Server returns empty reviews. The agent runs a regular review but
      // submits with type: 'summary' to match the claimed role.
      //
      // The result submission triggers postFinalReview on the server, which uses
      // crypto.subtle for JWT signing. Under fake timers this can hang when
      // previous tests leave residual microtask state. To avoid this, we
      // intercept the result submission fetch to verify type='summary' directly
      // without letting postFinalReview run.
      const taskId = await server.injectTask({ reviewCount: 1 });

      // Wrap the fake server fetch to capture the result submission body
      let resultBody: Record<string, unknown> | null = null;
      const originalFetch = globalThis.fetch;
      try {
        globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url =
            typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
          // Intercept the result submission — return success without hitting server
          if (url.includes(`/api/tasks/${taskId}/result`)) {
            if (typeof init?.body === 'string') {
              resultBody = JSON.parse(init.body);
            }
            return new Response(JSON.stringify({ success: true }), { status: 200 });
          }
          // Everything else goes through the real fake server
          return originalFetch(input, init);
        }) as typeof fetch;

        const agentPromise = startTestAgent('single-agent');
        // 2000ms is sufficient — result fetch is intercepted and returns instantly,
        // so no crypto.subtle or network round-trip occurs.
        await advanceTime(2000);

        // Tool was called (review execution happened)
        expect(mockedExecuteTool).toHaveBeenCalled();

        // Verify submission type is 'summary' (not 'review')
        expect(resultBody).not.toBeNull();
        expect(resultBody!.type).toBe('summary');

        // No type mismatch error
        expect(console.error).not.toHaveBeenCalledWith(
          expect.stringContaining('does not match submission type'),
        );

        await server.store.updateTask(taskId, { status: 'completed' });
        await stopAgent(agentPromise, server);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // K. Repo-scoped working directory (no codebase_dir)
  // ═══════════════════════════════════════════════════════════

  describe('K. Repo-scoped working directory when codebase_dir is not configured', () => {
    it('creates repo-scoped dir and passes it as cwd to review tool', async () => {
      const taskId = await server.injectTask({ reviewCount: 2 });

      const agentPromise = startTestAgent('repo-cwd-agent');
      await advanceTime(500);

      const expectedDir = path.join(
        os.homedir(),
        '.opencara',
        'repos',
        'test-org',
        'test-repo',
        taskId,
      );

      // Verify executeTool was called with the repo-scoped dir as cwd
      expect(mockedExecuteTool).toHaveBeenCalled();
      const toolCall = mockedExecuteTool.mock.calls[0];
      // executeTool args: (commandTemplate, prompt, timeoutMs, signal, vars, cwd)
      const cwdArg = toolCall[5];
      expect(cwdArg).toBe(expectedDir);

      // Verify log message
      expect(console.log).toHaveBeenCalledWith(
        expect.stringContaining(`Working directory: ${expectedDir}`),
      );

      await stopAgent(agentPromise, server);
    });

    it('cleans up repo-scoped dir after task completion', async () => {
      const taskId = await server.injectTask({ reviewCount: 2 });

      const agentPromise = startTestAgent('cleanup-agent');
      await advanceTime(500);

      const expectedDir = path.join(
        os.homedir(),
        '.opencara',
        'repos',
        'test-org',
        'test-repo',
        taskId,
      );

      // Verify the tool was called with the repo-scoped dir
      expect(mockedExecuteTool).toHaveBeenCalled();
      const cwdArg = mockedExecuteTool.mock.calls[0][5];
      expect(cwdArg).toBe(expectedDir);

      // After task completion, cleanupTaskDir removes the directory
      // Since mkdirSync actually runs, verify directory no longer exists
      expect(fs.existsSync(expectedDir)).toBe(false);

      await stopAgent(agentPromise, server);
    });

    it('does not use repo-scoped dir when codebase_dir is configured', async () => {
      await server.injectTask({ reviewCount: 2 });

      const deps = makeDeps('codebase-agent');
      const reviewDeps: ReviewExecutorDeps = {
        ...deps.reviewDeps,
        codebaseDir: '/tmp/test-codebase',
      };

      const agentPromise = startAgent(
        'codebase-agent',
        FAKE_SERVER_URL,
        { model: 'test-model', tool: 'test-tool' },
        reviewDeps,
        deps.consumptionDeps,
        { pollIntervalMs: 100 },
      );
      await advanceTime(500);

      // The "Working directory:" log should NOT appear (codebase_dir takes the clone path)
      const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
      const repoScopedLogs = logCalls.filter(
        (c: string[]) => typeof c[0] === 'string' && c[0].includes('Working directory:'),
      );
      expect(repoScopedLogs).toHaveLength(0);

      await stopAgent(agentPromise, server);
    });
  });
});
