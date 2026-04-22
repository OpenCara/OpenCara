/**
 * CLI ↔ Server integration tests.
 *
 * Runs the real CLI startAgent() against an in-process Hono server with
 * MemoryDataStore. Verifies cross-package contract: shared types, poll/claim
 * responses, result submission, and error handling match between CLI and server.
 *
 * Mocks: tool-executor (no real AI calls), globalThis.fetch (routes to Hono app).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startAgent, type ConsumptionDeps } from '../commands/agent.js';
import type { ReviewExecutorDeps } from '../review.js';
import { createSessionTracker } from '../consumption.js';
import { executeTool } from '../tool-executor.js';
import { FakeServer, FAKE_SERVER_URL } from './helpers/fake-server.js';

// ── Mock child_process so fetchDiffViaGh falls back to HTTP ──

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {
    ...actual,
    execFile: vi.fn((_cmd: string, _args: string[], _opts: unknown, cb?: (err: Error) => void) => {
      const callback = typeof _opts === 'function' ? _opts : cb;
      if (callback) {
        const err = new Error('gh not available in test');
        (err as NodeJS.ErrnoException).code = 'ENOENT';
        process.nextTick(() => callback(err));
      }
      return { pid: 0, kill: () => false };
    }),
  };
});

// ── Mock repo-cache so git worktree operations don't need real git ──
vi.mock('../repo-cache.js', async () => {
  const _fs = await import('node:fs');
  const _path = await import('node:path');
  return {
    checkoutWorktree: vi.fn(
      async (owner: string, repo: string, _prNumber: number, baseDir: string, taskId: string) => {
        const worktreePath = _path.join(baseDir, owner, `${repo}-worktrees`, taskId);
        const bareRepoPath = _path.join(baseDir, owner, `${repo}.git`);
        _fs.mkdirSync(worktreePath, { recursive: true });
        return { worktreePath, bareRepoPath, cloned: true };
      },
    ),
    cleanupWorktree: vi.fn(async (_bareRepoPath: string, worktreePath: string) => {
      try {
        _fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }),
    // With a worktree present, agent.ts requires a working git-diff path —
    // no silent fallback to gh. Mock a canned diff so task execution proceeds.
    diffFromWorktree: vi.fn(
      () =>
        'diff --git a/src/index.ts b/src/index.ts\n--- a/src/index.ts\n+++ b/src/index.ts\n@@ -1,1 +1,1 @@\n-foo\n+bar\n',
    ),
    withRepoLock: vi.fn(async (_repoKey: string, fn: () => unknown) => fn()),
  };
});

// ── Mock tool executor ───────────────────────────────────────

vi.mock('../tool-executor.js', () => ({
  executeTool: vi.fn(async () => ({
    stdout:
      '## Summary\nLooks good. No issues found.\n\n## Findings\nNo issues found.\n\n## Verdict\nAPPROVE',
    stderr: '',
    exitCode: 0,
    tokensUsed: 500,
    tokensParsed: true,
    tokenDetail: { input: 0, output: 500, total: 500, parsed: true },
  })),
  estimateTokens: (text: string) => Math.ceil(text.length / 4),
  validateCommandBinary: () => true,
  parseCommandTemplate: (cmd: string) => cmd.split(' '),
  testCommand: vi.fn(async () => ({ ok: true, elapsedMs: 100 })),
}));

const mockedExecuteTool = vi.mocked(executeTool);

// ── Helpers ──────────────────────────────────────────────────

function makeDeps(agentId = 'cli-agent'): {
  reviewDeps: ReviewExecutorDeps;
  consumptionDeps: ConsumptionDeps;
} {
  const session = createSessionTracker();
  return {
    reviewDeps: { commandTemplate: 'echo test', maxDiffSizeKb: 500 },
    consumptionDeps: { agentId, session },
  };
}

async function advanceTime(totalMs: number, stepMs = 50): Promise<void> {
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

describe('CLI ↔ Server Integration', () => {
  let server: FakeServer;

  beforeEach(async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(process, 'on').mockImplementation(() => process);

    server = new FakeServer();
    await server.install();

    mockedExecuteTool.mockReset();
    mockedExecuteTool.mockResolvedValue({
      stdout:
        '## Summary\nLooks good. No issues found.\n\n## Findings\nNo issues found.\n\n## Verdict\nAPPROVE',
      stderr: '',
      exitCode: 0,
      tokensUsed: 500,
      tokensParsed: true,
      tokenDetail: { input: 0, output: 500, total: 500, parsed: true },
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
      repoConfig?: import('@opencara/shared').RepoConfig;
    },
  ): Promise<void> {
    const deps = makeDeps(agentId);
    return startAgent(
      agentId,
      FAKE_SERVER_URL,
      { model: 'test-model', tool: 'test-tool' },
      deps.reviewDeps,
      deps.consumptionDeps,
      {
        pollIntervalMs: 100,
        reviewOnly: opts?.reviewOnly,
        repoConfig: opts?.repoConfig,
      },
    );
  }

  // ═══════════════════════════════════════════════════════════
  // A. CLI poll → claim → review → submit lifecycle
  // ═══════════════════════════════════════════════════════════

  describe('A. CLI agent poll → claim → submit lifecycle', () => {
    it('CLI agent claims review task and submits result via server API', async () => {
      // reviewCount=3 → 2 worker tasks; agent claims first one
      const taskId = await server.injectTask({ reviewCount: 3 });

      // Use reviewOnly to prevent agent from claiming summary tasks (which
      // would trigger the quality gate and eventually delete the entire group)
      const agentPromise = startTestAgent('cli-review-agent', { reviewOnly: true });
      await advanceTime(2000);

      // Verify claim was created on the first worker task
      const claims = await server.getClaims(taskId);
      expect(claims).toHaveLength(1);
      expect(claims[0].agent_id).toBe('cli-review-agent');
      expect(claims[0].role).toBe('review');
      expect(claims[0].status).toBe('completed');
      expect(claims[0].model).toBe('test-model');
      expect(claims[0].tool).toBe('test-tool');
      expect(claims[0].review_text).toBeDefined();
      expect(claims[0].tokens_used).toBe(500);

      // Tool was called
      expect(mockedExecuteTool).toHaveBeenCalled();

      // First task completed
      const task = await server.getTask(taskId);
      expect(task?.status).toBe('completed');

      await stopAgent(agentPromise, server);
    }, 15000);

    it('two CLI agents complete review slots sequentially', async () => {
      // Both agents independently process review tasks.
      // Agent 1 processes tasks from first injection, agent 2 from second.
      await server.injectTask({ reviewCount: 3 });

      const agent1Promise = startTestAgent('cli-r1', { reviewOnly: true });
      await advanceTime(2000);

      const agent1Calls = mockedExecuteTool.mock.calls.length;
      expect(agent1Calls).toBeGreaterThanOrEqual(1);

      await stopAgent(agent1Promise, server);
      await server.install();

      // Inject fresh tasks for agent 2
      await server.injectTask({ reviewCount: 3, prNumber: 2 });

      const agent2Promise = startTestAgent('cli-r2', { reviewOnly: true });
      await advanceTime(2000);

      // Agent 2 also completed at least one review
      expect(mockedExecuteTool.mock.calls.length).toBeGreaterThanOrEqual(agent1Calls + 1);

      await stopAgent(agent2Promise, server);
    }, 15000);
  });

  // ═══════════════════════════════════════════════════════════
  // B. CLI handles structured error responses from server
  // ═══════════════════════════════════════════════════════════

  describe('B. CLI handles structured server errors', () => {
    it('CLI handles claim conflict gracefully (slot taken)', async () => {
      const taskId = await server.injectTask();

      // Pre-claim: move task to reviewing status (atomic CAS already done)
      await server.store.updateTask(taskId, { status: 'reviewing' });

      const agentPromise = startTestAgent('late-cli-agent');
      await advanceTime(500);

      // Agent should not have crashed — just failed to claim
      expect(mockedExecuteTool).not.toHaveBeenCalled();

      await stopAgent(agentPromise, server);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // C. CLI with review_only flag
  // ═══════════════════════════════════════════════════════════

  describe('C. review_only flag via CLI', () => {
    it('CLI agent with reviewOnly skips summary-only tasks', async () => {
      await server.injectTask({ reviewCount: 1 }); // summary only

      const agentPromise = startTestAgent('review-only-cli', { reviewOnly: true });
      await advanceTime(500);

      expect(mockedExecuteTool).not.toHaveBeenCalled();

      await stopAgent(agentPromise, server);
    });

    it('CLI agent with reviewOnly claims review tasks', async () => {
      const taskId = await server.injectTask({ reviewCount: 3 });

      const agentPromise = startTestAgent('review-only-cli', { reviewOnly: true });
      await advanceTime(2000);

      const claims = await server.getClaims(taskId);
      expect(claims).toHaveLength(1);
      expect(claims[0].role).toBe('review');
      expect(claims[0].status).toBe('completed');

      await stopAgent(agentPromise, server);
    }, 15000);
  });

  // ═══════════════════════════════════════════════════════════
  // D. CLI repo filtering via server poll
  // ═══════════════════════════════════════════════════════════

  describe('D. CLI repo config filtering', () => {
    it('CLI agent with repo whitelist skips non-matching tasks', async () => {
      await server.injectTask({ reviewCount: 2 }); // owner: test-org, repo: test-repo

      const agentPromise = startTestAgent('filtered-cli', {
        repoConfig: { mode: 'whitelist', list: ['other-org/other-repo'] },
      });
      await advanceTime(500);

      expect(mockedExecuteTool).not.toHaveBeenCalled();

      await stopAgent(agentPromise, server);
    });

    it('CLI agent with matching whitelist claims the task', async () => {
      // reviewCount=3 → 2 separate worker tasks; agent claims first one
      await server.injectTask({ reviewCount: 3 });

      const agentPromise = startTestAgent('filtered-cli', {
        repoConfig: { mode: 'whitelist', list: ['test-org/test-repo'] },
        reviewOnly: true,
      });
      await advanceTime(2000);

      // Tool was called — agent claimed and reviewed a task
      expect(mockedExecuteTool).toHaveBeenCalled();

      await stopAgent(agentPromise, server);
    }, 15000);
  });

  // ═══════════════════════════════════════════════════════════
  // E. CLI tool execution failure → server error report
  // ═══════════════════════════════════════════════════════════

  describe('E. Tool execution failure → error reported to server', () => {
    it('tool crash reports error to server, slot is freed', async () => {
      const taskId = await server.injectTask({ reviewCount: 2 });
      mockedExecuteTool.mockRejectedValue(new Error('Tool SIGSEGV'));

      const agentPromise = startTestAgent('crash-cli');
      await advanceTime(3000);

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Error on task'));

      // Task should be back to pending (freed for re-claim)
      const task = await server.getTask(taskId);
      expect(task?.status).toBe('pending');

      // Mark completed to stop loop
      await server.store.updateTask(taskId, { status: 'completed' });
      await stopAgent(agentPromise, server);
    }, 30000);
  });

  // ═══════════════════════════════════════════════════════════
  // F. Schema contract: shared types match between CLI and server
  // ═══════════════════════════════════════════════════════════

  describe('F. Schema contract verification', () => {
    const authHeaders = {
      'Content-Type': 'application/json',
      Authorization: 'Bearer ghu_fake_test_token',
    };

    it('server poll response matches shared PollResponse shape', async () => {
      await server.injectTask({ reviewCount: 2 });

      // Make a raw poll request to verify response shape
      const res = await server.app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ agent_id: 'schema-test' }),
        },
        server.env,
      );
      const body = (await res.json()) as Record<string, unknown>;

      // PollResponse shape
      expect(body).toHaveProperty('tasks');
      expect(Array.isArray(body.tasks)).toBe(true);

      const tasks = body.tasks as Record<string, unknown>[];
      expect(tasks).toHaveLength(1);

      // PollTask shape — every field the CLI expects
      const task = tasks[0];
      expect(typeof task.task_id).toBe('string');
      expect(typeof task.owner).toBe('string');
      expect(typeof task.repo).toBe('string');
      expect(typeof task.pr_number).toBe('number');
      expect(typeof task.diff_url).toBe('string');
      expect(typeof task.timeout_seconds).toBe('number');
      expect(typeof task.prompt).toBe('string');
      expect(typeof task.role).toBe('string');
      expect(['review', 'summary']).toContain(task.role);
    });

    it('server claim response matches shared ClaimResponse shape', async () => {
      const taskId = await server.injectTask({ reviewCount: 2 });

      const res = await server.app.request(
        `/api/tasks/${taskId}/claim`,
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ agent_id: 'schema-test', role: 'review', model: 'm', tool: 't' }),
        },
        server.env,
      );
      const body = (await res.json()) as Record<string, unknown>;

      // ClaimResponse shape
      expect(res.status).toBe(200);
      expect(body.claimed).toBe(true);
    });

    it('server error response matches shared ErrorResponse shape', async () => {
      const res = await server.app.request(
        '/api/tasks/any/claim',
        {
          method: 'POST',
          headers: authHeaders,
          body: JSON.stringify({ agent_id: 'a' }), // missing role
        },
        server.env,
      );
      const body = (await res.json()) as Record<string, unknown>;

      // ErrorResponse shape
      expect(res.status).toBe(400);
      expect(body).toHaveProperty('error');
      const error = body.error as Record<string, unknown>;
      expect(typeof error.code).toBe('string');
      expect(typeof error.message).toBe('string');
    });
  });

  // ═══════════════════════════════════════════════════════════
  // G. Private repo task visibility from CLI
  // ═══════════════════════════════════════════════════════════

  describe('G. Private repo tasks via CLI', () => {
    it('CLI agent with repo whitelist can see and claim private tasks', async () => {
      // reviewCount=3 → 2 worker tasks; agent claims first one
      const taskId = await server.injectTask({
        owner: 'corp',
        repo: 'secret',
        reviewCount: 3,
        private: true,
      });

      const agentPromise = startTestAgent('private-cli-agent', {
        repoConfig: { mode: 'whitelist', list: ['corp/secret'] },
        reviewOnly: true,
      });
      await advanceTime(2000);

      const claims = await server.getClaims(taskId);
      expect(claims).toHaveLength(1);
      expect(claims[0].status).toBe('completed');
      expect(claims[0].agent_id).toBe('private-cli-agent');

      await stopAgent(agentPromise, server);
    }, 15000);

    it('CLI agent without repo whitelist cannot see private tasks', async () => {
      await server.injectTask({
        owner: 'corp',
        repo: 'secret',
        reviewCount: 2,
        private: true,
      });

      const agentPromise = startTestAgent('no-repos-cli');
      await advanceTime(500);

      // Agent should not have picked up the private task
      expect(mockedExecuteTool).not.toHaveBeenCalled();

      await stopAgent(agentPromise, server);
    });
  });
});
