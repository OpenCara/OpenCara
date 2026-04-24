/**
 * Additional agent.ts tests targeting uncovered lines:
 * - startAgent without reviewDeps (early exit)
 * - startAgentByIndex (no command, invalid binary, router mode, auth resolution)
 * - executeSummaryTask with reviews (multi-agent summary)
 * - executeSummaryTask with empty reviews in router mode
 * - executeReviewTask in router mode
 * - safeReject/safeError failure paths
 * - sleep abort edge cases
 * - fetchDiff with API URL conversion and token auth
 * - handleTask codebase clone paths
 * - DiffTooLargeError / InputTooLargeError rejection paths
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { startAgent, type ConsumptionDeps } from '../commands/agent.js';
import type { ReviewExecutorDeps } from '../review.js';
import { createSessionTracker } from '../consumption.js';
import { FakeServer, FAKE_SERVER_URL } from './helpers/fake-server.js';
import { executeTool, startHeartbeatTimer } from '../tool-executor.js';
import { checkoutWorktree, diffFromWorktree } from '../repo-cache.js';

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
    // Stub sync variant so isGhAvailable() returns false fast (no real
    // `gh auth status` subprocess blocking the test event loop).
    execFileSync: vi.fn(() => {
      const err: NodeJS.ErrnoException = Object.assign(new Error('gh not available in test'), {
        code: 'ENOENT',
      });
      throw err;
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
  validateCommandBinary: vi.fn(() => true),
  parseCommandTemplate: (cmd: string) => cmd.split(' '),
  testCommand: vi.fn(async () => ({ ok: true, elapsedMs: 100 })),
  DEFAULT_HEARTBEAT_INTERVAL_MS: 60_000,
  startHeartbeatTimer: vi.fn(() => () => {}),
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

describe('Agent Coverage Tests', () => {
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
      maxDiffSizeKb?: number;
      repoConfig?: import('@opencara/shared').RepoConfig;
      authToken?: string;
      codebaseDir?: string;
    },
  ): Promise<void> {
    const deps = makeDeps(agentId);
    const reviewDeps: ReviewExecutorDeps = {
      ...deps.reviewDeps,
      ...(opts?.maxDiffSizeKb != null ? { maxDiffSizeKb: opts.maxDiffSizeKb } : {}),
      ...(opts?.codebaseDir != null ? { codebaseDir: opts.codebaseDir } : {}),
    };

    return startAgent(
      agentId,
      FAKE_SERVER_URL,
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      deps.consumptionDeps,
      {
        pollIntervalMs: 100,
        reviewOnly: opts?.reviewOnly,
        repoConfig: opts?.repoConfig,
        authToken: opts?.authToken,
      },
    );
  }

  // ═══════════════════════════════════════════════════════════
  // startAgent without reviewDeps → early exit
  // ═══════════════════════════════════════════════════════════

  describe('startAgent without reviewDeps', () => {
    it('logs error and returns immediately', async () => {
      const promise = startAgent(
        'agent-no-deps',
        FAKE_SERVER_URL,
        { model: 'test', tool: 'test' },
        undefined,
        undefined,
      );
      await advanceTime(100);
      await promise;

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('No review command configured. Set command in config.toml'),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Multi-agent summary with actual reviews
  // ═══════════════════════════════════════════════════════════

  describe('Multi-agent summary with reviews', () => {
    it('agent receives summary role with existing reviews and submits summary', async () => {
      // Create a task with review_count=3 (2 worker tasks + summary auto-created)
      const taskId = await server.injectTask({ reviewCount: 3 });

      // Get the group ID from the first task
      const firstTask = await server.getTask(taskId);
      const groupId = firstTask!.group_id;

      // Get worker tasks and complete them manually
      const groupTasks = await server.store.getTasksByGroup(groupId);
      const workerTasks = groupTasks.filter((t) => t.task_type !== 'summary');

      for (let i = 0; i < workerTasks.length; i++) {
        const wt = workerTasks[i];
        await server.store.updateTask(wt.id, { status: 'completed' });
        await server.store.createClaim({
          id: `${wt.id}:reviewer-${i + 1}:review`,
          task_id: wt.id,
          agent_id: `reviewer-${i + 1}`,
          role: 'review',
          status: 'completed',
          review_text:
            i === 0
              ? '## Summary\nLGTM\n\n## Verdict\nAPPROVE'
              : '## Summary\nSome issues found\n\n## Verdict\nCOMMENT',
          verdict: i === 0 ? 'approve' : 'comment',
          model: `model-${i + 1}`,
          tool: `tool-${i + 1}`,
          created_at: Date.now(),
        });
      }

      // Manually create the summary task (simulates what the result handler does)
      const summaryTaskId = `summary-${groupId}`;
      await server.store.createTask({
        ...firstTask!,
        id: summaryTaskId,
        task_type: 'summary',
        status: 'pending',
        queue: 'summary',
        created_at: Date.now(),
        timeout_at: Date.now() + 600_000,
      });

      // Intercept result submission to avoid crypto.subtle issues
      let resultBody: Record<string, unknown> | null = null;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(`/api/tasks/${summaryTaskId}/result`)) {
          if (typeof init?.body === 'string') {
            resultBody = JSON.parse(init.body);
          }
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const agentPromise = startTestAgent('summary-agent');
        await advanceTime(2000);

        expect(mockedExecuteTool).toHaveBeenCalled();
        expect(resultBody).not.toBeNull();
        expect(resultBody!.type).toBe('summary');

        await server.store.updateTask(summaryTaskId, { status: 'completed' });
        await stopAgent(agentPromise, server);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Diff fetch with GitHub token and API URL conversion
  // ═══════════════════════════════════════════════════════════

  describe('fetchDiff with token', () => {
    it('uses API URL and Bearer token when githubToken is provided', async () => {
      // Force the gh/HTTP diff path by failing worktree checkout — with a
      // worktree the agent always uses local git-diff and never hits gh.
      vi.mocked(checkoutWorktree).mockRejectedValueOnce(new Error('no worktree in test'));

      let diffFetchUrl: string | undefined;
      let diffFetchHeaders: Record<string, string> | undefined;

      const originalFetch = globalThis.fetch;
      server.uninstallFetch();
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        if (url.includes('/api/tasks/poll')) {
          return new Response(
            JSON.stringify({
              tasks: [
                {
                  task_id: 'task-token',
                  owner: 'test-org',
                  repo: 'test-repo',
                  pr_number: 42,
                  diff_url: 'https://github.com/test-org/test-repo/pull/42.diff',
                  timeout_seconds: 300,
                  prompt: 'Review',
                  role: 'review',
                },
              ],
            }),
            { status: 200 },
          );
        }

        if (url.includes('/claim')) {
          return new Response(JSON.stringify({ claimed: true }), { status: 200 });
        }

        if (url.includes('api.github.com/repos') && url.includes('/pulls/')) {
          const headers = init?.headers as Record<string, string> | undefined;
          const accept = headers?.['Accept'] ?? '';
          // PR context fetches use application/vnd.github+json — return JSON
          if (accept.includes('+json')) {
            return new Response(JSON.stringify([]), { status: 200 });
          }
          // Diff fetch uses application/vnd.github.v3.diff — capture for assertion
          diffFetchUrl = url;
          diffFetchHeaders = headers;
          return new Response('diff --git a/f b/f', { status: 200 });
        }

        // PR context issue comments endpoint
        if (url.includes('api.github.com/repos') && url.includes('/issues/')) {
          return new Response(JSON.stringify([]), { status: 200 });
        }

        if (url.includes('/result') || url.includes('/reject') || url.includes('/error')) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }) as typeof fetch;

      try {
        const deps = makeDeps('token-agent');

        const promise = startAgent(
          'token-agent',
          'http://fake-server',
          { model: 'test', tool: 'test' },
          deps.reviewDeps,
          deps.consumptionDeps,
          { pollIntervalMs: 100, authToken: 'gho_testtoken123' },
        );

        await advanceTime(500);

        expect(diffFetchUrl).toContain('api.github.com/repos/test-org/test-repo/pulls/42');
        expect(diffFetchHeaders?.['Authorization']).toBe('Bearer gho_testtoken123');
        expect(diffFetchHeaders?.['Accept']).toBe('application/vnd.github.v3.diff');

        // Stop agent
        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'shutdown' } }),
        });
        await advanceTime(3000);
        await promise;
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Diff fetch failure → safeReject reports to server
  // ═══════════════════════════════════════════════════════════

  describe('safeReject and safeError failure paths', () => {
    it('logs locally when reject endpoint fails', async () => {
      // Force the gh/HTTP diff path by failing worktree checkout — with a
      // worktree the agent always uses local git-diff and never hits gh.
      vi.mocked(checkoutWorktree).mockRejectedValueOnce(new Error('no worktree in test'));

      const originalFetch = globalThis.fetch;
      server.uninstallFetch();

      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        if (url.includes('/api/tasks/poll')) {
          return new Response(
            JSON.stringify({
              tasks: [
                {
                  task_id: 'task-reject-fail',
                  owner: 'o',
                  repo: 'r',
                  pr_number: 1,
                  diff_url: 'https://github.com/o/r/pull/1.diff',
                  timeout_seconds: 300,
                  prompt: 'Review',
                  role: 'review',
                },
              ],
            }),
            { status: 200 },
          );
        }

        if (url.includes('/claim')) {
          return new Response(JSON.stringify({ claimed: true }), { status: 200 });
        }

        // Diff fetch fails with 404 (non-retryable)
        if (url.includes('.diff') || url.includes('/pulls/')) {
          return new Response('Not Found', { status: 404 });
        }

        // Reject endpoint also fails
        if (url.includes('/reject')) {
          return new Response('Server Error', { status: 500 });
        }

        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }) as typeof fetch;

      try {
        const deps = makeDeps('reject-fail-agent');
        const promise = startAgent(
          'reject-fail-agent',
          'http://fake-server',
          { model: 'test', tool: 'test' },
          deps.reviewDeps,
          deps.consumptionDeps,
          { pollIntervalMs: 100 },
        );

        await advanceTime(3000);

        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Failed to report rejection'),
        );

        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'shutdown' } }),
        });
        await advanceTime(3000);
        await promise;
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('logs locally when error endpoint fails', async () => {
      const originalFetch = globalThis.fetch;
      server.uninstallFetch();

      // Make the tool throw to trigger safeError path
      mockedExecuteTool.mockRejectedValue(new Error('Tool crashed'));

      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        if (url.includes('/api/tasks/poll')) {
          return new Response(
            JSON.stringify({
              tasks: [
                {
                  task_id: 'task-error-fail',
                  owner: 'o',
                  repo: 'r',
                  pr_number: 1,
                  diff_url: 'https://github.com/o/r/pull/1.diff',
                  timeout_seconds: 300,
                  prompt: 'Review',
                  role: 'review',
                },
              ],
            }),
            { status: 200 },
          );
        }

        if (url.includes('/claim')) {
          return new Response(JSON.stringify({ claimed: true }), { status: 200 });
        }

        if (url.includes('.diff') || url.includes('/pulls/')) {
          return new Response('diff content here is long enough to be valid', { status: 200 });
        }

        // Error endpoint fails
        if (url.includes('/error')) {
          return new Response('Server Error', { status: 500 });
        }

        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }) as typeof fetch;

      try {
        const deps = makeDeps('error-fail-agent');
        const reviewDeps: ReviewExecutorDeps = {
          ...deps.reviewDeps,
          maxDiffSizeKb: 500,
        };

        const promise = startAgent(
          'error-fail-agent',
          'http://fake-server',
          { model: 'test', tool: 'test' },
          reviewDeps,
          deps.consumptionDeps,
          { pollIntervalMs: 100 },
        );

        await advanceTime(3000);

        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('Failed to report error'),
        );

        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'shutdown' } }),
        });
        await advanceTime(3000);
        await promise;
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Claim failure with HttpError status
  // ═══════════════════════════════════════════════════════════

  describe('Claim failure paths', () => {
    it('logs HttpError status when claim fails', async () => {
      const originalFetch = globalThis.fetch;
      server.uninstallFetch();

      globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        if (url.includes('/api/tasks/poll')) {
          return new Response(
            JSON.stringify({
              tasks: [
                {
                  task_id: 'task-claim-fail',
                  owner: 'o',
                  repo: 'r',
                  pr_number: 1,
                  diff_url: 'https://github.com/o/r/pull/1.diff',
                  timeout_seconds: 300,
                  prompt: 'Review',
                  role: 'review',
                },
              ],
            }),
            { status: 200 },
          );
        }

        // Claim returns 409 Conflict with structured error
        if (url.includes('/claim')) {
          return new Response(
            JSON.stringify({ error: { code: 'CLAIM_CONFLICT', message: 'No slots available' } }),
            { status: 409 },
          );
        }

        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }) as typeof fetch;

      try {
        const deps = makeDeps('claim-fail-agent');
        const promise = startAgent(
          'claim-fail-agent',
          'http://fake-server',
          { model: 'test', tool: 'test' },
          deps.reviewDeps,
          deps.consumptionDeps,
          { pollIntervalMs: 100 },
        );

        await advanceTime(2000);

        expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Claim rejected'));

        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          json: () =>
            Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Invalid credentials' } }),
        });
        await advanceTime(3000);
        await promise;
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Codebase clone failure path
  // ═══════════════════════════════════════════════════════════

  describe('Codebase clone paths', () => {
    it('warns and routes an empty base_ref through the local git-diff path', async () => {
      // Server-write invariant (PR #781): MemoryDataStore throws
      // MissingBaseRefError on a PR-scoped insert with empty base_ref, so we
      // cannot inject that state directly. Instead we inject with a valid
      // base_ref and rewrite the PollResponse here to simulate the read-path
      // edge case (a legitimate production possibility if the server's
      // log-and-allow path ever emits `''` via D1).
      const mockedDiff = vi.mocked(diffFromWorktree);
      mockedDiff.mockClear();

      const taskId = await server.injectTask({ reviewCount: 2, baseRef: 'main' });

      const deps = makeDeps('missing-base-ref-agent');
      const reviewDeps: ReviewExecutorDeps = {
        ...deps.reviewDeps,
        codebaseDir: '/tmp/test-codebases',
      };

      // Spy only on diff-content endpoints — PR-context fetches (comments,
      // reviews) are unrelated to the diff path and still run normally.
      // A worktree is available, so the diff URL and the .diff Accept header
      // MUST NOT be touched while the empty-base_ref path runs.
      const ghFetchSpy = vi.fn();
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        const headers = init?.headers as Record<string, string> | undefined;
        const accept = headers?.['Accept'] ?? '';
        const isDiffUrl = url.endsWith('.diff');
        const isApiDiffFetch =
          url.includes('api.github.com/repos') &&
          url.includes('/pulls/') &&
          accept.includes('diff');
        if (isDiffUrl || isApiDiffFetch) {
          ghFetchSpy(url);
        }
        if (url.includes(`/api/tasks/${taskId}/result`)) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        const response = await originalFetch(input, init);

        // Rewrite the poll response to strip base_ref on our target task,
        // simulating the server emitting an empty base_ref on the read path.
        if (url.includes('/api/tasks/poll') && response.ok) {
          const body = (await response.clone().json()) as {
            tasks?: Array<Record<string, unknown>>;
          };
          if (Array.isArray(body.tasks)) {
            body.tasks = body.tasks.map((t) => (t.task_id === taskId ? { ...t, base_ref: '' } : t));
          }
          return new Response(JSON.stringify(body), {
            status: response.status,
            statusText: response.statusText,
            headers: Object.fromEntries(response.headers.entries()),
          });
        }

        return response;
      }) as typeof fetch;

      try {
        const promise = startAgent(
          'missing-base-ref-agent',
          FAKE_SERVER_URL,
          { model: 'test', tool: 'test' },
          reviewDeps,
          deps.consumptionDeps,
          { pollIntervalMs: 100 },
        );

        await advanceTime(2000);

        expect(console.warn).toHaveBeenCalledWith(
          expect.stringMatching(/no base_ref.*deriving default branch/i),
        );
        // Agent actually called diffFromWorktree (not silently fell through
        // to gh). baseRef argument is the 3rd positional arg.
        expect(mockedDiff).toHaveBeenCalled();
        const baseRefArg = mockedDiff.mock.calls[0][2];
        expect(baseRefArg === '' || baseRefArg === undefined || baseRefArg === null).toBe(true);
        expect(ghFetchSpy).not.toHaveBeenCalled();

        await server.store.updateTask(taskId, { status: 'completed' });
        await stopAgent(promise, server);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('rejects the task when worktree exists but git diff fails — never falls back to gh', async () => {
      // With a worktree present, git-diff is the ONLY diff path. If it
      // throws, the task should be rejected with the propagated error and
      // the gh/HTTP diff endpoint MUST NOT be touched. This protects against
      // the silent degradation #775 was filed for.
      const mockedDiff = vi.mocked(diffFromWorktree);
      mockedDiff.mockImplementationOnce(() => {
        throw new Error('fatal: bad revision HEAD');
      });

      const taskId = await server.injectTask({ reviewCount: 2 });

      // Spy every outbound fetch — we must never see a call to the diff URL
      // or GitHub's REST diff endpoint while the worktree is available.
      const ghFetchSpy = vi.fn();

      let rejectBody: Record<string, unknown> | null = null;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        // Any diff-url or GitHub PR diff fetch is a contract violation here.
        if (url.includes('.diff') || url.includes('/pulls/') || url.includes('api.github.com')) {
          ghFetchSpy(url);
        }
        if (url.includes(`/api/tasks/${taskId}/reject`)) {
          if (typeof init?.body === 'string') rejectBody = JSON.parse(init.body);
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const deps = makeDeps('git-diff-fail-agent');
        const reviewDeps: ReviewExecutorDeps = {
          ...deps.reviewDeps,
          codebaseDir: '/tmp/test-codebases',
        };

        const promise = startAgent(
          'git-diff-fail-agent',
          FAKE_SERVER_URL,
          { model: 'test', tool: 'test' },
          reviewDeps,
          deps.consumptionDeps,
          { pollIntervalMs: 100 },
        );

        await advanceTime(2000);

        // Loud error logged, task rejected, and no gh/HTTP diff fetch
        expect(console.error).toHaveBeenCalledWith(
          expect.stringContaining('git diff failed for task'),
        );
        expect(ghFetchSpy).not.toHaveBeenCalled();
        expect(rejectBody).not.toBeNull();
        expect(rejectBody).toMatchObject({
          reason: expect.stringMatching(/Cannot access diff.*bad revision/),
        });

        await server.store.updateTask(taskId, { status: 'completed' });
        await stopAgent(promise, server);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('continues with diff-only when worktree checkout fails', async () => {
      // Override checkoutWorktree to throw for this test
      const mockedCheckout = vi.mocked(checkoutWorktree);
      mockedCheckout.mockRejectedValueOnce(new Error('git clone failed'));

      const taskId = await server.injectTask({ reviewCount: 2 });

      const deps = makeDeps('clone-fail-agent');
      const reviewDeps: ReviewExecutorDeps = {
        ...deps.reviewDeps,
        codebaseDir: '/tmp/test-codebases',
      };

      // Intercept result submission
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(`/api/tasks/${taskId}/result`)) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const promise = startAgent(
          'clone-fail-agent',
          FAKE_SERVER_URL,
          { model: 'test', tool: 'test' },
          reviewDeps,
          deps.consumptionDeps,
          { pollIntervalMs: 100 },
        );

        await advanceTime(2000);

        // Should have warned about checkout failure but still submitted a review
        expect(console.warn).toHaveBeenCalledWith(
          expect.stringContaining('worktree checkout failed'),
        );

        await server.store.updateTask(taskId, { status: 'completed' });
        await stopAgent(promise, server);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // InputTooLargeError path (summary too large)
  // ═══════════════════════════════════════════════════════════

  describe('InputTooLargeError rejection', () => {
    it('rejects task when summary input exceeds limit', async () => {
      const taskId = await server.injectTask({ reviewCount: 3 });

      // Get the group ID from the first task
      const firstTask = await server.getTask(taskId);
      const groupId = firstTask!.group_id;

      // Complete worker tasks manually
      const groupTasks = await server.store.getTasksByGroup(groupId);
      const workerTasks = groupTasks.filter((t) => t.task_type !== 'summary');

      // Create review claims with huge text to exceed MAX_INPUT_SIZE_BYTES default (500KB)
      const hugeReview = 'x'.repeat(300 * 1024);
      for (let i = 0; i < workerTasks.length; i++) {
        const wt = workerTasks[i];
        await server.store.updateTask(wt.id, { status: 'completed' });
        await server.store.createClaim({
          id: `${wt.id}:r${i + 1}:review`,
          task_id: wt.id,
          agent_id: `r${i + 1}`,
          role: 'review',
          status: 'completed',
          review_text: hugeReview,
          verdict: i === 0 ? 'approve' : 'comment',
          created_at: Date.now(),
        });
      }

      // Create summary task manually
      const summaryTaskId = `summary-${groupId}`;
      await server.store.createTask({
        ...firstTask!,
        id: summaryTaskId,
        task_type: 'summary',
        status: 'pending',
        queue: 'summary',
        created_at: Date.now(),
        timeout_at: Date.now() + 600_000,
      });

      const agentPromise = startTestAgent('large-summary-agent');
      await advanceTime(3000);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Summary input too large'),
      );

      await server.store.updateTask(summaryTaskId, { status: 'completed' });
      await stopAgent(agentPromise, server);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Diff fetch repeated failures → skip task
  // ═══════════════════════════════════════════════════════════

  describe('Diff fetch repeated failures', () => {
    it('skips task after MAX_DIFF_FETCH_ATTEMPTS failures', async () => {
      // Force the gh/HTTP diff path: with a worktree, the agent uses local
      // git-diff and this retry counter never fires.
      vi.mocked(checkoutWorktree).mockRejectedValue(new Error('no worktree in test'));

      await server.injectTask({ reviewCount: 2 });
      server.diffFetchError = true;

      const agentPromise = startTestAgent('diff-retry-agent');

      // Wait for 3 diff fetch failures (MAX_DIFF_FETCH_ATTEMPTS=3)
      await advanceTime(5000);

      expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('Skipping task'));

      await stopAgent(agentPromise, server);
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Router relay paths in executeReviewTask and executeSummaryTask
  // ═══════════════════════════════════════════════════════════

  describe('Router relay mode', () => {
    function createMockRouterRelay() {
      return {
        start: vi.fn(),
        stop: vi.fn(),
        buildReviewPrompt: vi.fn(() => 'router review prompt'),
        buildSummaryPrompt: vi.fn(() => 'router summary prompt'),
        sendPrompt: vi.fn(async () => '## Summary\nRouter OK\n\n## Verdict\nAPPROVE'),
        parseReviewResponse: vi.fn(() => ({ review: 'Router OK', verdict: 'approve' })),
      };
    }

    it('executeReviewTask uses routerRelay for review', async () => {
      const taskId = await server.injectTask({ reviewCount: 2 });
      const mockRelay = createMockRouterRelay();

      let resultBody: Record<string, unknown> | null = null;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(`/api/tasks/${taskId}/result`)) {
          if (typeof init?.body === 'string') {
            resultBody = JSON.parse(init.body);
          }
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const deps = makeDeps('router-review-agent');
        const promise = startAgent(
          'router-review-agent',
          FAKE_SERVER_URL,
          { model: 'test', tool: 'test' },
          deps.reviewDeps,
          deps.consumptionDeps,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { pollIntervalMs: 100, routerRelay: mockRelay as any },
        );

        await advanceTime(2000);

        expect(mockRelay.buildReviewPrompt).toHaveBeenCalled();
        expect(mockRelay.sendPrompt).toHaveBeenCalledWith(
          'review_request',
          taskId,
          'router review prompt',
          expect.any(Number),
        );
        expect(mockRelay.parseReviewResponse).toHaveBeenCalled();
        expect(resultBody).not.toBeNull();
        expect(resultBody!.type).toBe('review');

        await server.store.updateTask(taskId, { status: 'completed' });
        await stopAgent(promise, server);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('executeSummaryTask uses routerRelay for single-agent summary', async () => {
      // review_count=1 → single-agent mode → summary with no prior reviews
      const taskId = await server.injectTask({ reviewCount: 1 });
      const mockRelay = createMockRouterRelay();

      let resultBody: Record<string, unknown> | null = null;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(`/api/tasks/${taskId}/result`)) {
          if (typeof init?.body === 'string') {
            resultBody = JSON.parse(init.body);
          }
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const deps = makeDeps('router-summary-agent');
        const promise = startAgent(
          'router-summary-agent',
          FAKE_SERVER_URL,
          { model: 'test', tool: 'test' },
          deps.reviewDeps,
          deps.consumptionDeps,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { pollIntervalMs: 100, routerRelay: mockRelay as any },
        );

        await advanceTime(2000);

        // Single-agent summary uses buildReviewPrompt (not buildSummaryPrompt)
        expect(mockRelay.buildReviewPrompt).toHaveBeenCalled();
        expect(mockRelay.sendPrompt).toHaveBeenCalled();
        expect(resultBody).not.toBeNull();
        expect(resultBody!.type).toBe('summary');

        await server.store.updateTask(taskId, { status: 'completed' });
        await stopAgent(promise, server);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('executeSummaryTask uses routerRelay for multi-agent summary', async () => {
      // review_count=3 → 2 worker tasks; complete them manually and create summary task
      const taskId = await server.injectTask({ reviewCount: 3 });
      const mockRelay = createMockRouterRelay();

      // Get group and complete workers
      const firstTask = await server.getTask(taskId);
      const groupId = firstTask!.group_id;
      const groupTasks = await server.store.getTasksByGroup(groupId);
      const workerTasks = groupTasks.filter((t) => t.task_type !== 'summary');

      for (let i = 0; i < workerTasks.length; i++) {
        const wt = workerTasks[i];
        await server.store.updateTask(wt.id, { status: 'completed' });
        await server.store.createClaim({
          id: `${wt.id}:reviewer-${i + 1}:review`,
          task_id: wt.id,
          agent_id: `reviewer-${i + 1}`,
          role: 'review',
          status: 'completed',
          review_text:
            i === 0
              ? '## Summary\nLGTM\n\n## Verdict\nAPPROVE'
              : '## Summary\nIssues found\n\n## Verdict\nCOMMENT',
          verdict: i === 0 ? 'approve' : 'comment',
          model: `model-${i + 1}`,
          tool: `tool-${i + 1}`,
          created_at: Date.now(),
        });
      }

      // Create summary task
      const summaryTaskId = `summary-${groupId}`;
      await server.store.createTask({
        ...firstTask!,
        id: summaryTaskId,
        task_type: 'summary',
        status: 'pending',
        queue: 'summary',
        created_at: Date.now(),
        timeout_at: Date.now() + 600_000,
      });

      let resultBody: Record<string, unknown> | null = null;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(`/api/tasks/${summaryTaskId}/result`)) {
          if (typeof init?.body === 'string') {
            resultBody = JSON.parse(init.body);
          }
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const deps = makeDeps('router-multi-summary-agent');
        const promise = startAgent(
          'router-multi-summary-agent',
          FAKE_SERVER_URL,
          { model: 'test', tool: 'test' },
          deps.reviewDeps,
          deps.consumptionDeps,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { pollIntervalMs: 100, routerRelay: mockRelay as any },
        );

        await advanceTime(2000);

        // Multi-agent summary uses buildSummaryPrompt
        expect(mockRelay.buildSummaryPrompt).toHaveBeenCalled();
        expect(mockRelay.sendPrompt).toHaveBeenCalledWith(
          'summary_request',
          summaryTaskId,
          'router summary prompt',
          expect.any(Number),
        );
        expect(resultBody).not.toBeNull();
        expect(resultBody!.type).toBe('summary');

        await server.store.updateTask(summaryTaskId, { status: 'completed' });
        await stopAgent(promise, server);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('arms a heartbeat around router-mode sendPrompt (regression for #782)', async () => {
      // Router mode skips executeReview → executeTool, so the heartbeat must
      // be armed explicitly around routerRelay.sendPrompt via runWithHeartbeat
      // (which delegates to startHeartbeatTimer). The mocked startHeartbeatTimer
      // spy records each call.
      const taskId = await server.injectTask({ reviewCount: 2 });
      const mockRelay = createMockRouterRelay();

      const mockedStartHeartbeat = vi.mocked(startHeartbeatTimer);
      mockedStartHeartbeat.mockClear();

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(`/api/tasks/${taskId}/result`)) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const deps = makeDeps('router-heartbeat-agent');
        const promise = startAgent(
          'router-heartbeat-agent',
          FAKE_SERVER_URL,
          { model: 'test', tool: 'test' },
          deps.reviewDeps,
          deps.consumptionDeps,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { pollIntervalMs: 100, routerRelay: mockRelay as any },
        );

        await advanceTime(2000);

        expect(mockRelay.sendPrompt).toHaveBeenCalled();
        // `runWithHeartbeat` → `startHeartbeatTimer` must have been called
        // with a defined HeartbeatControl (wiring confirmed).
        const heartbeatCalls = mockedStartHeartbeat.mock.calls.filter((c) => c[0] !== undefined);
        expect(heartbeatCalls.length).toBeGreaterThan(0);
        // Each call's first arg should be a HeartbeatControl (callback + intervalMs).
        for (const call of heartbeatCalls) {
          expect(call[0]).toMatchObject({
            callback: expect.any(Function),
            intervalMs: expect.any(Number),
          });
        }

        await server.store.updateTask(taskId, { status: 'completed' });
        await stopAgent(promise, server);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // fetchDiff with non-API URL and token (lines 104-106)
  // ═══════════════════════════════════════════════════════════

  describe('fetchDiff with non-API URL and token', () => {
    it('adds Bearer token to non-API diff URL', async () => {
      // Force the gh/HTTP diff path by failing worktree checkout — with a
      // worktree the agent always uses local git-diff and never hits gh.
      vi.mocked(checkoutWorktree).mockRejectedValueOnce(new Error('no worktree in test'));

      let diffFetchUrl: string | undefined;
      let diffFetchHeaders: Record<string, string> | undefined;

      const originalFetch = globalThis.fetch;
      server.uninstallFetch();
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        if (url.includes('/api/tasks/poll')) {
          return new Response(
            JSON.stringify({
              tasks: [
                {
                  task_id: 'task-nonapi',
                  owner: 'o',
                  repo: 'r',
                  pr_number: 1,
                  // Use a non-github.com URL that won't get API-converted
                  diff_url: 'https://custom-git.example.com/o/r/pull/1.diff',
                  timeout_seconds: 300,
                  prompt: 'Review',
                  role: 'review',
                },
              ],
            }),
            { status: 200 },
          );
        }

        if (url.includes('/claim')) {
          return new Response(JSON.stringify({ claimed: true }), { status: 200 });
        }

        if (url.includes('custom-git.example.com')) {
          diffFetchUrl = url;
          diffFetchHeaders = init?.headers as Record<string, string>;
          return new Response('diff --git a/f b/f', { status: 200 });
        }

        if (url.includes('/result') || url.includes('/reject') || url.includes('/error')) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }) as typeof fetch;

      try {
        const deps = makeDeps('nonapi-diff-agent');

        const promise = startAgent(
          'nonapi-diff-agent',
          'http://fake-server',
          { model: 'test', tool: 'test' },
          deps.reviewDeps,
          deps.consumptionDeps,
          { pollIntervalMs: 100, authToken: 'gho_customtoken' },
        );

        await advanceTime(500);

        expect(diffFetchUrl).toContain('custom-git.example.com');
        expect(diffFetchHeaders?.['Authorization']).toBe('Bearer gho_customtoken');

        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'shutdown' } }),
        });
        await advanceTime(3000);
        await promise;
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // PR URL logging (#278) and command logging (#277)
  // ═══════════════════════════════════════════════════════════

  describe('Logging improvements', () => {
    it('logs PR URL instead of diff URL when handling a task', async () => {
      const taskId = await server.injectTask({
        owner: 'my-org',
        repo: 'my-repo',
        prNumber: 42,
        reviewCount: 2,
      });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(`/api/tasks/${taskId}/result`)) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const agentPromise = startTestAgent('pr-url-agent');
        await advanceTime(2000);

        // Should log PR URL, not diff URL
        expect(console.log).toHaveBeenCalledWith(
          expect.stringContaining('https://github.com/my-org/my-repo/pull/42'),
        );

        await server.store.updateTask(taskId, { status: 'completed' });
        await stopAgent(agentPromise, server);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('logs review command before executing review task', async () => {
      const taskId = await server.injectTask({ reviewCount: 2 });

      let resultBody: Record<string, unknown> | null = null;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(`/api/tasks/${taskId}/result`)) {
          if (typeof init?.body === 'string') {
            resultBody = JSON.parse(init.body);
          }
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const agentPromise = startTestAgent('review-cmd-agent');
        await advanceTime(2000);

        expect(resultBody).not.toBeNull();
        expect(resultBody!.type).toBe('review');
        expect(console.log).toHaveBeenCalledWith(
          expect.stringContaining('Executing review: echo test'),
        );

        await server.store.updateTask(taskId, { status: 'completed' });
        await stopAgent(agentPromise, server);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('logs summary command before executing summary task', async () => {
      const taskId = await server.injectTask({ reviewCount: 1 });

      let resultBody: Record<string, unknown> | null = null;
      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(`/api/tasks/${taskId}/result`)) {
          if (typeof init?.body === 'string') {
            resultBody = JSON.parse(init.body);
          }
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const agentPromise = startTestAgent('summary-cmd-agent');
        await advanceTime(2000);

        expect(resultBody).not.toBeNull();
        expect(resultBody!.type).toBe('summary');
        expect(console.log).toHaveBeenCalledWith(
          expect.stringContaining('Executing summary: echo test'),
        );

        await server.store.updateTask(taskId, { status: 'completed' });
        await stopAgent(agentPromise, server);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('sanitizes tokens in logged command', async () => {
      const taskId = await server.injectTask({ reviewCount: 2 });

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(`/api/tasks/${taskId}/result`)) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        // Use a command template with a GitHub token embedded
        const deps = makeDeps('sanitize-agent');
        const reviewDeps: ReviewExecutorDeps = {
          ...deps.reviewDeps,
          commandTemplate: 'claude --token ghp_secrettoken123abc --print',
        };

        const agentPromise = startAgent(
          'sanitize-agent',
          FAKE_SERVER_URL,
          { model: 'test', tool: 'test' },
          reviewDeps,
          deps.consumptionDeps,
          { pollIntervalMs: 100 },
        );

        await advanceTime(2000);

        // The command should be logged with the token sanitized
        expect(console.log).toHaveBeenCalledWith(
          expect.stringContaining('Executing review: claude --token *** --print'),
        );

        await server.store.updateTask(taskId, { status: 'completed' });
        await stopAgent(agentPromise, server);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('logs router mode for review command in router relay', async () => {
      const taskId = await server.injectTask({ reviewCount: 2 });
      const mockRelay = {
        start: vi.fn(),
        stop: vi.fn(),
        buildReviewPrompt: vi.fn(() => 'router review prompt'),
        buildSummaryPrompt: vi.fn(() => 'router summary prompt'),
        sendPrompt: vi.fn(async () => '## Summary\nRouter OK\n\n## Verdict\nAPPROVE'),
        parseReviewResponse: vi.fn(() => ({ review: 'Router OK', verdict: 'approve' })),
      };

      const originalFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(`/api/tasks/${taskId}/result`)) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return originalFetch(input, init);
      }) as typeof fetch;

      try {
        const deps = makeDeps('router-log-agent');
        const promise = startAgent(
          'router-log-agent',
          FAKE_SERVER_URL,
          { model: 'test', tool: 'test' },
          deps.reviewDeps,
          deps.consumptionDeps,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          { pollIntervalMs: 100, routerRelay: mockRelay as any },
        );

        await advanceTime(2000);

        expect(console.log).toHaveBeenCalledWith(
          expect.stringContaining('Executing review: [router mode]'),
        );

        await server.store.updateTask(taskId, { status: 'completed' });
        await stopAgent(promise, server);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Streaming diff size guard (issue #351)
  // ═══════════════════════════════════════════════════════════

  describe('fetchDiff streaming size guard', () => {
    it('aborts early when Content-Length exceeds maxDiffSizeKb', async () => {
      // Force the gh/HTTP diff path by failing worktree checkout — with a
      // worktree the agent always uses local git-diff and never hits gh.
      vi.mocked(checkoutWorktree).mockRejectedValueOnce(new Error('no worktree in test'));

      const originalFetch = globalThis.fetch;
      server.uninstallFetch();

      let rejectCalled = false;
      let rejectReason = '';

      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        if (url.includes('/api/tasks/poll')) {
          return new Response(
            JSON.stringify({
              tasks: [
                {
                  task_id: 'task-cl-guard',
                  owner: 'test-org',
                  repo: 'test-repo',
                  pr_number: 1,
                  diff_url: 'https://github.com/test-org/test-repo/pull/1.diff',
                  timeout_seconds: 300,
                  prompt: 'Review',
                  role: 'review',
                },
              ],
            }),
            { status: 200 },
          );
        }

        if (url.includes('/claim')) {
          return new Response(JSON.stringify({ claimed: true }), { status: 200 });
        }

        if (url.includes('.diff') || url.includes('/pull/')) {
          // Return response with Content-Length far exceeding the 1KB limit
          return new Response('small body', {
            status: 200,
            headers: { 'Content-Length': '204800' }, // 200KB
          });
        }

        if (url.includes('/reject')) {
          rejectCalled = true;
          const body = JSON.parse((init?.body as string) ?? '{}');
          rejectReason = body.reason ?? '';
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        if (url.includes('/result') || url.includes('/error')) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }) as typeof fetch;

      try {
        const deps = makeDeps('cl-guard-agent');
        // Set maxDiffSizeKb to 1KB — Content-Length of 200KB will exceed this
        const reviewDeps: ReviewExecutorDeps = { ...deps.reviewDeps, maxDiffSizeKb: 1 };

        const promise = startAgent(
          'cl-guard-agent',
          'http://fake-server',
          { model: 'test', tool: 'test' },
          reviewDeps,
          deps.consumptionDeps,
          { pollIntervalMs: 100 },
        );

        await advanceTime(2000);

        // The diff fetch should have been rejected due to Content-Length
        expect(rejectCalled).toBe(true);
        expect(rejectReason).toMatch(/Diff too large.*Content-Length/);

        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'shutdown' } }),
        });
        await advanceTime(3000);
        await promise;
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('aborts mid-stream when accumulated bytes exceed maxDiffSizeKb', async () => {
      // Force the gh/HTTP diff path by failing worktree checkout — with a
      // worktree the agent always uses local git-diff and never hits gh.
      vi.mocked(checkoutWorktree).mockRejectedValueOnce(new Error('no worktree in test'));

      const originalFetch = globalThis.fetch;
      server.uninstallFetch();

      let rejectCalled = false;
      let rejectReason = '';

      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        if (url.includes('/api/tasks/poll')) {
          return new Response(
            JSON.stringify({
              tasks: [
                {
                  task_id: 'task-stream-guard',
                  owner: 'test-org',
                  repo: 'test-repo',
                  pr_number: 1,
                  diff_url: 'https://github.com/test-org/test-repo/pull/1.diff',
                  timeout_seconds: 300,
                  prompt: 'Review',
                  role: 'review',
                },
              ],
            }),
            { status: 200 },
          );
        }

        if (url.includes('/claim')) {
          return new Response(JSON.stringify({ claimed: true }), { status: 200 });
        }

        if (url.includes('.diff') || url.includes('/pull/')) {
          // Return a large body without Content-Length header so the stream guard triggers
          const largeBody = 'x'.repeat(3072); // 3KB
          return new Response(largeBody, { status: 200 });
        }

        if (url.includes('/reject')) {
          rejectCalled = true;
          const body = JSON.parse((init?.body as string) ?? '{}');
          rejectReason = body.reason ?? '';
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        if (url.includes('/result') || url.includes('/error')) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }) as typeof fetch;

      try {
        const deps = makeDeps('stream-guard-agent');
        // Set maxDiffSizeKb to 1KB — the 3KB body will exceed this during streaming
        const reviewDeps: ReviewExecutorDeps = { ...deps.reviewDeps, maxDiffSizeKb: 1 };

        const promise = startAgent(
          'stream-guard-agent',
          'http://fake-server',
          { model: 'test', tool: 'test' },
          reviewDeps,
          deps.consumptionDeps,
          { pollIntervalMs: 100 },
        );

        await advanceTime(2000);

        // The diff fetch should have been rejected due to streaming size
        expect(rejectCalled).toBe(true);
        expect(rejectReason).toMatch(/Diff too large/);

        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'shutdown' } }),
        });
        await advanceTime(3000);
        await promise;
      } finally {
        globalThis.fetch = originalFetch;
      }
    });

    it('fetches diff normally when under maxDiffSizeKb limit', async () => {
      const originalFetch = globalThis.fetch;
      server.uninstallFetch();

      let resultSubmitted = false;

      globalThis.fetch = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

        if (url.includes('/api/tasks/poll')) {
          return new Response(
            JSON.stringify({
              tasks: [
                {
                  task_id: 'task-normal-diff',
                  owner: 'test-org',
                  repo: 'test-repo',
                  pr_number: 1,
                  diff_url: 'https://github.com/test-org/test-repo/pull/1.diff',
                  timeout_seconds: 300,
                  prompt: 'Review',
                  role: 'review',
                },
              ],
            }),
            { status: 200 },
          );
        }

        if (url.includes('/claim')) {
          return new Response(JSON.stringify({ claimed: true }), { status: 200 });
        }

        if (url.includes('.diff') || url.includes('/pull/')) {
          // Return a small diff — well under 500KB limit
          return new Response('diff --git a/f b/f\n+small change', { status: 200 });
        }

        if (url.includes('/result')) {
          resultSubmitted = true;
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        if (url.includes('/reject') || url.includes('/error')) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        // PR context endpoints
        if (url.includes('api.github.com')) {
          return new Response(JSON.stringify([]), { status: 200 });
        }

        return new Response(JSON.stringify({ tasks: [] }), { status: 200 });
      }) as typeof fetch;

      try {
        const deps = makeDeps('normal-diff-agent');
        // maxDiffSizeKb is 500 (default from makeDeps), small diff should pass

        const promise = startAgent(
          'normal-diff-agent',
          'http://fake-server',
          { model: 'test', tool: 'test' },
          deps.reviewDeps,
          deps.consumptionDeps,
          { pollIntervalMs: 100 },
        );

        await advanceTime(2000);

        // The review result should have been submitted (not rejected)
        expect(resultSubmitted).toBe(true);

        globalThis.fetch = vi.fn().mockResolvedValue({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'shutdown' } }),
        });
        await advanceTime(3000);
        await promise;
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Contributor attribution in review submissions
  // ═══════════════════════════════════════════════════════════

  describe('Review submission (no contributor attribution)', () => {
    it('submitted review text does not contain contributor attribution', async () => {
      // With OAuth, identity is derived server-side from the token.
      // The CLI no longer sends githubUsername or appends contributor info.
      const taskId = await server.injectTask({ reviewCount: 1 });

      let resultBody: Record<string, unknown> | null = null;
      const savedFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(`/api/tasks/${taskId}/result`)) {
          if (typeof init?.body === 'string') {
            resultBody = JSON.parse(init.body);
          }
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return savedFetch(input, init);
      }) as typeof fetch;

      try {
        const agentPromise = startTestAgent('no-attrib-agent');
        await advanceTime(2000);

        expect(resultBody).not.toBeNull();
        expect(resultBody!.review_text).not.toContain('Contributed by');
        expect(resultBody!.review_text).not.toContain('Contributors');

        await server.store.updateTask(taskId, { status: 'completed' });
        await stopAgent(agentPromise, server);
      } finally {
        globalThis.fetch = savedFetch;
      }
    });
  });

  // ═══════════════════════════════════════════════════════════
  // Issue-based tasks (pr_number=0) — skip diff fetch
  // ═══════════════════════════════════════════════════════════

  describe('Issue-based tasks (pr_number=0)', () => {
    it('issue_triage task succeeds without diff fetch', async () => {
      // Return triage JSON from the tool executor
      mockedExecuteTool.mockResolvedValueOnce({
        stdout: JSON.stringify({
          category: 'bug',
          module: 'cli',
          priority: 'high',
          size: 'S',
          labels: ['bug', 'cli'],
          summary: 'Test issue summary',
          body: 'Test issue body',
          comment: 'This is a bug in the CLI module.',
        }),
        stderr: '',
        exitCode: 0,
        tokensUsed: 200,
        tokensParsed: true,
        tokenDetail: { input: 0, output: 200, total: 200, parsed: true },
      });

      const taskId = await server.injectIssueTask({ taskType: 'issue_triage' });

      let resultBody: Record<string, unknown> | null = null;
      const savedFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(`/api/tasks/${taskId}/result`)) {
          if (typeof init?.body === 'string') {
            resultBody = JSON.parse(init.body);
          }
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return savedFetch(input, init);
      }) as typeof fetch;

      try {
        const agentPromise = startTestAgent('triage-agent');
        await advanceTime(2000);

        // Should have logged "Issue-based task" and NOT tried to fetch a diff
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Issue-based task'));

        // Result should have been submitted
        expect(resultBody).not.toBeNull();
        expect(resultBody!.type).toBe('issue_triage');

        await server.store.updateTask(taskId, { status: 'completed' });
        await stopAgent(agentPromise, server);
      } finally {
        globalThis.fetch = savedFetch;
      }
    });

    it('issue_dedup task succeeds without diff fetch', async () => {
      // Return dedup JSON from the tool executor
      mockedExecuteTool.mockResolvedValueOnce({
        stdout: JSON.stringify({
          duplicates: [],
          index_entry: '- 42(bug): Test issue',
        }),
        stderr: '',
        exitCode: 0,
        tokensUsed: 150,
        tokensParsed: true,
        tokenDetail: { input: 0, output: 150, total: 150, parsed: true },
      });

      const taskId = await server.injectIssueTask({ taskType: 'issue_dedup' });

      let resultBody: Record<string, unknown> | null = null;
      const savedFetch = globalThis.fetch;
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes(`/api/tasks/${taskId}/result`)) {
          if (typeof init?.body === 'string') {
            resultBody = JSON.parse(init.body);
          }
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return savedFetch(input, init);
      }) as typeof fetch;

      try {
        const agentPromise = startTestAgent('dedup-agent');
        await advanceTime(2000);

        // Should have logged "Issue-based task" and NOT tried to fetch a diff
        expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Issue-based task'));

        // Result should have been submitted
        expect(resultBody).not.toBeNull();
        expect(resultBody!.type).toBe('issue_dedup');

        await server.store.updateTask(taskId, { status: 'completed' });
        await stopAgent(agentPromise, server);
      } finally {
        globalThis.fetch = savedFetch;
      }
    });

    it('issue task does not attempt diff fetch (no diff URL failure)', async () => {
      mockedExecuteTool.mockResolvedValueOnce({
        stdout: JSON.stringify({
          category: 'feature',
          module: 'server',
          priority: 'medium',
          size: 'M',
          labels: ['enhancement'],
          summary: 'New feature',
          body: 'Feature description',
          comment: 'Feature request for server.',
        }),
        stderr: '',
        exitCode: 0,
        tokensUsed: 180,
        tokensParsed: true,
        tokenDetail: { input: 0, output: 180, total: 180, parsed: true },
      });

      const taskId = await server.injectIssueTask({ taskType: 'issue_triage' });

      const savedFetch = globalThis.fetch;
      const fetchCalls: string[] = [];
      globalThis.fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        fetchCalls.push(url);
        if (url.includes(`/api/tasks/${taskId}/result`)) {
          return new Response(JSON.stringify({ success: true }), { status: 200 });
        }
        return savedFetch(input, init);
      }) as typeof fetch;

      try {
        const agentPromise = startTestAgent('no-diff-agent');
        await advanceTime(2000);

        // No diff-related fetch calls should have been made
        const diffCalls = fetchCalls.filter(
          (u) => u.includes('.diff') || u.includes('application/vnd.github.v3.diff'),
        );
        expect(diffCalls).toHaveLength(0);

        await server.store.updateTask(taskId, { status: 'completed' });
        await stopAgent(agentPromise, server);
      } finally {
        globalThis.fetch = savedFetch;
      }
    });
  });
});
