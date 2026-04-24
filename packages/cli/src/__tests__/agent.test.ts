import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  startAgent,
  computeRoles,
  createHeartbeatControl,
  isLongRunningRole,
  type ConsumptionDeps,
} from '../commands/agent.js';
import type { ReviewExecutorDeps } from '../review.js';
import type { RouterRelay } from '../router.js';
import { createSessionTracker } from '../consumption.js';
import type { LocalAgentConfig } from '../config.js';
import { HttpError, type ApiClient } from '../http.js';
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from '../tool-executor.js';
import type { Logger } from '../logger.js';

// Mock child_process so fetchDiffViaGh falls back to HTTP
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

vi.mock('../tool-executor.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    testCommand: vi.fn().mockResolvedValue({ ok: true, elapsedMs: 150 }),
    executeTool: vi.fn().mockResolvedValue({
      stdout: '## Summary\nLooks good.\n\n## Findings\nNo issues found.\n\n## Verdict\nAPPROVE',
      stderr: '',
      exitCode: 0,
      tokensUsed: 100,
      tokensParsed: true,
      tokenDetail: { input: 0, output: 100, total: 100, parsed: true },
    }),
  };
});

import { testCommand } from '../tool-executor.js';
import { checkoutWorktree } from '../repo-cache.js';

const originalFetch = globalThis.fetch;

function makeDeps(): { reviewDeps: ReviewExecutorDeps; consumptionDeps: ConsumptionDeps } {
  const session = createSessionTracker();
  return {
    reviewDeps: { commandTemplate: 'echo test', maxDiffSizeKb: 500 },
    consumptionDeps: { agentId: 'test-agent', session },
  };
}

describe('agent poll loop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    // Suppress console output in tests
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Prevent signal handlers from accumulating
    vi.spyOn(process, 'on').mockImplementation(() => process);
    // Reset testCommand mock default (vi.restoreAllMocks clears it)
    vi.mocked(testCommand).mockResolvedValue({ ok: true, elapsedMs: 150 });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('exits after 3 consecutive auth failures', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
      }),
    );

    const { reviewDeps, consumptionDeps } = makeDeps();

    const promise = startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      {
        pollIntervalMs: 100,
      },
    );

    // 3 auth errors + sleep intervals between them
    // poll 1: 401 (auth=1, consecutive=1) → no extra backoff → sleep 100
    await vi.advanceTimersByTimeAsync(100);
    // poll 2: 401 (auth=2, consecutive=2) → backoff extra 100 → sleep 100
    await vi.advanceTimersByTimeAsync(200);
    // poll 3: 401 (auth=3) → exits
    await vi.advanceTimersByTimeAsync(100);

    await promise;

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Authentication failed repeatedly. Exiting.'),
    );
  });

  it('backs off exponentially on consecutive non-auth failures', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 3) {
        return Promise.reject(new Error('Network error'));
      }
      // 4th call succeeds, then we need it to keep returning empty to avoid hanging
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ tasks: [] }),
      });
    });

    const { reviewDeps, consumptionDeps } = makeDeps();

    // Don't await — the loop runs until we advance timers
    void startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      {
        pollIntervalMs: 1000,
      },
    );

    // Flush microtasks so testCommand dry-run resolves and first poll fires
    await vi.advanceTimersByTimeAsync(0);

    // poll 1 fires immediately. error (consecutive=1), backoff=1000 → no extra delay
    // Then normal sleep 1000ms
    expect(callCount).toBe(1);
    await vi.advanceTimersByTimeAsync(1000);
    // poll 2 fires. error (consecutive=2), backoff=2000 → extra delay 1000 + normal sleep 1000
    expect(callCount).toBe(2);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('2 consecutive'));
    await vi.advanceTimersByTimeAsync(2000);
    // poll 3 fires. error (consecutive=3), backoff=4000 → extra delay 3000 + normal sleep 1000
    expect(callCount).toBe(3);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('3 consecutive'));
    await vi.advanceTimersByTimeAsync(4000);
    // poll 4 fires (success) → resets consecutiveErrors
    expect(callCount).toBe(4);

    // After success, normal sleep 1000ms, then poll 5
    await vi.advanceTimersByTimeAsync(1000);
    expect(callCount).toBe(5);

    // Verify no backoff warnings after success
    const warnCalls = (console.warn as ReturnType<typeof vi.fn>).mock.calls;
    const backoffWarns = warnCalls.filter(
      (c: string[]) => typeof c[0] === 'string' && c[0].includes('consecutive'),
    );
    expect(backoffWarns).toHaveLength(2); // Only warnings for consecutive=2 and consecutive=3
  });

  it('does not exit on non-auth errors', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount <= 3) {
        return Promise.reject(new Error('Network error'));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ tasks: [] }),
      });
    });

    const { reviewDeps, consumptionDeps } = makeDeps();

    void startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      {
        pollIntervalMs: 100,
      },
    );

    // Advance enough for 3 failures + backoff + 1 success
    await vi.advanceTimersByTimeAsync(10000);

    // Should NOT have exited with auth error message
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Authentication failed repeatedly. Exiting.'),
    );
    // Agent is still running (callCount > 3 means it got past the errors)
    expect(callCount).toBeGreaterThan(3);
  });

  it('logs model and tool on startup', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
      }),
    );

    const { reviewDeps, consumptionDeps } = makeDeps();

    const promise = startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'claude-sonnet-4-6', tool: 'claude' },
      reviewDeps,
      consumptionDeps,
      { pollIntervalMs: 100 },
    );

    // Let it fail out with auth errors
    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Model: claude-sonnet-4-6 | Tool: claude'),
    );
  });

  it('includes model and tool in claim request body', async () => {
    let claimBody: Record<string, unknown> | null = null;

    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url);

      // First call: poll → return a task
      if (urlStr.includes('/api/tasks/poll')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              tasks: [
                {
                  task_id: 'task-1',
                  owner: 'test-owner',
                  repo: 'test-repo',
                  pr_number: 42,
                  diff_url: 'https://github.com/test/repo/pull/42',
                  timeout_seconds: 300,
                  prompt: 'Review this PR',
                  role: 'review',
                },
              ],
            }),
        });
      }

      // Claim call — capture the body
      if (urlStr.includes('/claim')) {
        claimBody = JSON.parse(init?.body as string);
        // Return structured error so the loop doesn't try to fetch a diff
        return Promise.resolve({
          ok: false,
          status: 409,
          json: () =>
            Promise.resolve({
              error: { code: 'CLAIM_CONFLICT', message: 'No slots available' },
            }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ tasks: [] }),
      });
    });

    const { reviewDeps, consumptionDeps } = makeDeps();

    void startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'claude-sonnet-4-6', tool: 'claude' },
      reviewDeps,
      consumptionDeps,
      { pollIntervalMs: 100 },
    );

    // Advance enough for poll + claim
    await vi.advanceTimersByTimeAsync(200);

    expect(claimBody).not.toBeNull();
    expect(claimBody).toMatchObject({
      agent_id: 'test-agent',
      role: 'review',
      model: 'claude-sonnet-4-6',
      tool: 'claude',
    });
  });

  it('sends review_only in poll request when option is set', async () => {
    let pollBody: Record<string, unknown> | null = null;

    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url);

      if (urlStr.includes('/api/tasks/poll')) {
        pollBody = JSON.parse(init?.body as string);
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ tasks: [] }),
      });
    });

    const { reviewDeps, consumptionDeps } = makeDeps();

    const promise = startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      { pollIntervalMs: 100, reviewOnly: true },
    );

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(pollBody).not.toBeNull();
    expect(pollBody!.review_only).toBe(true);
  });

  it('does not send review_only when option is not set', async () => {
    let pollBody: Record<string, unknown> | null = null;

    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url);

      if (urlStr.includes('/api/tasks/poll')) {
        pollBody = JSON.parse(init?.body as string);
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ tasks: [] }),
      });
    });

    const { reviewDeps, consumptionDeps } = makeDeps();

    const promise = startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      { pollIntervalMs: 100 },
    );

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(pollBody).not.toBeNull();
    expect(pollBody!.review_only).toBeUndefined();
  });

  it('sends repos list in poll request for mode:public with private repos', async () => {
    let pollBody: Record<string, unknown> | null = null;

    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url);

      if (urlStr.includes('/api/tasks/poll')) {
        pollBody = JSON.parse(init?.body as string);
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ tasks: [] }),
      });
    });

    const { reviewDeps, consumptionDeps } = makeDeps();

    const promise = startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      {
        pollIntervalMs: 100,
        repoConfig: { mode: 'public', list: ['org/private-repo'] },
      },
    );

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(pollBody).not.toBeNull();
    expect(pollBody!.repos).toEqual(['org/private-repo']);
  });

  it('prefixes log output with label when provided', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
      }),
    );

    const { reviewDeps, consumptionDeps } = makeDeps();

    const promise = startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      { pollIntervalMs: 100, label: 'My Claude Agent' },
    );

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    // Label should appear in log output
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('My Claude Agent'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Agent started'));
    expect(console.log).toHaveBeenCalledWith(
      expect.stringContaining('Model: test-model | Tool: test-tool'),
    );
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Authentication failed repeatedly. Exiting.'),
    );
    // Exit summary should be printed
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Shutting down'));
  });

  it('does not prefix log output when no label is provided', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
      }),
    );

    const { reviewDeps, consumptionDeps } = makeDeps();

    const promise = startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      { pollIntervalMs: 100 },
    );

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    // Should log agent started and exit summary
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Agent started'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Shutting down'));
    // All log lines have timestamps [HH:MM:SS] but no agent label prefix
    const logCalls = (console.log as ReturnType<typeof vi.fn>).mock.calls;
    // Timestamps like [12:34:56] are expected, but custom labels like [My Agent] are not
    // Strip ANSI escape codes before matching (picocolors adds brackets like [2m, [22m)
    // eslint-disable-next-line no-control-regex
    const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');
    const hasCustomLabel = logCalls.some(
      (c: string[]) =>
        typeof c[0] === 'string' && /\[(?!\d{2}:\d{2}:\d{2}\])[^\]]+\]/.test(stripAnsi(c[0])),
    );
    expect(hasCustomLabel).toBe(false);
  });

  it('resets auth counter on successful poll', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      // 2 auth failures, then success, then 2 more auth failures
      if (callCount <= 2 || (callCount >= 4 && callCount <= 5)) {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
        });
      }
      if (callCount === 3) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ tasks: [] }),
        });
      }
      // After 5 calls, succeed to prevent infinite auth errors
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ tasks: [] }),
      });
    });

    const { reviewDeps, consumptionDeps } = makeDeps();

    void startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      {
        pollIntervalMs: 100,
      },
    );

    // Advance enough for all 5+ polls
    await vi.advanceTimersByTimeAsync(20000);

    // After call 3 (success), auth counter resets. Calls 4-5 are 401 but only 2 consecutive,
    // so it should NOT exit with repeated auth failure.
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Authentication failed repeatedly. Exiting.'),
    );
    expect(callCount).toBeGreaterThanOrEqual(5);
  });

  it('runs command dry-run test on startup and logs ok', async () => {
    vi.mocked(testCommand).mockResolvedValue({ ok: true, elapsedMs: 1200 });

    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
      }),
    );

    const { reviewDeps, consumptionDeps } = makeDeps();

    const promise = startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      { pollIntervalMs: 100 },
    );

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(testCommand).toHaveBeenCalledWith('echo test', undefined);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Testing command...'));
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Command test ok (1.2s)'));
  });

  it('warns but continues when command dry-run fails', async () => {
    vi.mocked(testCommand).mockResolvedValue({
      ok: false,
      elapsedMs: 500,
      error: 'command exited with code 1',
    });

    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
      }),
    );

    const { reviewDeps, consumptionDeps } = makeDeps();

    const promise = startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      { pollIntervalMs: 100 },
    );

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Command test failed (command exited with code 1). Reviews may fail.',
      ),
    );
    // Agent should still enter poll loop (auth errors prove it did)
    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Authentication failed repeatedly. Exiting.'),
    );
  });

  it('skips command dry-run in router mode', async () => {
    vi.mocked(testCommand).mockClear();

    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
      }),
    );

    const { reviewDeps, consumptionDeps } = makeDeps();

    // Create a minimal router relay mock
    const fakeRouter = { start: vi.fn(), stop: vi.fn() } as unknown;

    const promise = startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      { pollIntervalMs: 100, routerRelay: fakeRouter as RouterRelay },
    );

    await vi.advanceTimersByTimeAsync(1000);
    await promise;

    expect(testCommand).not.toHaveBeenCalled();
  });

  it('passes AbortSignal to fetch when fetching diff', async () => {
    // Force the gh/HTTP diff path: with a worktree, the agent uses local
    // git-diff and the AbortSignal never touches the diff URL fetch.
    vi.mocked(checkoutWorktree).mockRejectedValueOnce(new Error('no worktree in test'));

    let diffFetchInit: RequestInit | undefined;

    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : String(url);

      if (urlStr.includes('/api/tasks/poll')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              tasks: [
                {
                  task_id: 'task-1',
                  owner: 'test-owner',
                  repo: 'test-repo',
                  pr_number: 42,
                  diff_url: 'https://github.com/test/repo/pull/42.diff',
                  timeout_seconds: 300,
                  prompt: 'Review this PR',
                  role: 'review',
                },
              ],
            }),
        });
      }

      if (urlStr.includes('/claim')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ claimed: true, role: 'review' }),
        });
      }

      // Diff fetch — capture init to check signal
      if (urlStr.includes('.diff')) {
        diffFetchInit = init;
        return Promise.resolve(new Response('diff content', { status: 200 }));
      }

      // Reject endpoint (called after review — just succeed)
      if (urlStr.includes('/reject') || urlStr.includes('/result') || urlStr.includes('/error')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true }),
        });
      }

      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ tasks: [] }),
      });
    });

    const { reviewDeps, consumptionDeps } = makeDeps();

    void startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      { pollIntervalMs: 100 },
    );

    // Advance enough for poll + claim + diff fetch
    await vi.advanceTimersByTimeAsync(500);

    expect(diffFetchInit).toBeDefined();
    expect(diffFetchInit!.signal).toBeInstanceOf(AbortSignal);
    expect(diffFetchInit!.signal!.aborted).toBe(false);
  });

  it('exits after maxConsecutiveErrors threshold', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const { reviewDeps, consumptionDeps } = makeDeps();

    const promise = startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      {
        pollIntervalMs: 100,
        maxConsecutiveErrors: 3,
      },
    );

    // Advance through 3 consecutive errors with backoff
    // poll 1: error (consecutive=1), no extra backoff, sleep 100
    await vi.advanceTimersByTimeAsync(100);
    // poll 2: error (consecutive=2), backoff=200, extra 100, sleep 100
    await vi.advanceTimersByTimeAsync(300);
    // poll 3: error (consecutive=3) → exits
    await vi.advanceTimersByTimeAsync(100);

    await promise;

    expect(console.error).toHaveBeenCalledWith(
      expect.stringContaining('Too many consecutive errors (3/3). Shutting down.'),
    );
    expect(process.exitCode).toBe(1);
  });

  it('resets consecutive error count on successful poll', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      // Fail first 2, then succeed, then fail 2 more, then succeed forever
      if (callCount <= 2 || (callCount >= 4 && callCount <= 5)) {
        return Promise.reject(new Error('Network error'));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ tasks: [] }),
      });
    });

    const { reviewDeps, consumptionDeps } = makeDeps();

    void startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      {
        pollIntervalMs: 100,
        maxConsecutiveErrors: 3,
      },
    );

    // Advance enough for 6 polls (errors reset on success, never hits 3 consecutive)
    // poll 1: error (1), sleep 100
    await vi.advanceTimersByTimeAsync(100);
    // poll 2: error (2), backoff extra 100, sleep 100
    await vi.advanceTimersByTimeAsync(300);
    // poll 3: success (reset to 0), sleep 100
    await vi.advanceTimersByTimeAsync(100);
    // poll 4: error (1), sleep 100
    await vi.advanceTimersByTimeAsync(100);
    // poll 5: error (2), backoff extra 100, sleep 100
    await vi.advanceTimersByTimeAsync(300);
    // poll 6: success (reset to 0), sleep 100
    await vi.advanceTimersByTimeAsync(100);

    // Should still be running — never hit 3 consecutive
    expect(console.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Too many consecutive errors'),
    );
  });

  it('sends roles and synthesize_repos in poll request (no github_username)', async () => {
    let pollCount = 0;
    const fetchCalls: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.body) {
        fetchCalls.push({ url, body: JSON.parse(init.body as string) });
      }
      if (typeof url === 'string' && url.includes('/api/tasks/poll')) {
        pollCount++;
        if (pollCount >= 2) {
          // Force exit via auth error after we've captured the first poll
          return Promise.resolve({
            ok: false,
            status: 401,
            json: () =>
              Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
          });
        }
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ tasks: [] }),
      });
    });

    const { reviewDeps, consumptionDeps } = makeDeps();

    const promise = startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      {
        pollIntervalMs: 100,
        maxConsecutiveErrors: 1,
        roles: ['review', 'summary'],

        synthesizeRepos: { mode: 'whitelist', list: ['org/repo'] },
      },
    );

    // Let the first poll fire (testCommand dry-run + poll)
    await vi.advanceTimersByTimeAsync(0);

    // Find the poll request
    const pollCall = fetchCalls.find((c) => c.url.includes('/api/tasks/poll'));
    expect(pollCall).toBeDefined();
    expect(pollCall!.body.roles).toEqual(['review', 'summary']);
    // github_username is no longer sent in poll requests (identity from OAuth)
    expect(pollCall!.body.github_username).toBeUndefined();
    expect(pollCall!.body.synthesize_repos).toEqual({
      mode: 'whitelist',
      list: ['org/repo'],
    });

    // Advance to let the loop exit on the next error
    await vi.advanceTimersByTimeAsync(200);
    await promise;
  });

  it('does not send github_username in claim request', async () => {
    let pollCount = 0;
    const fetchCalls: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.body) {
        fetchCalls.push({ url, body: JSON.parse(init.body as string) });
      }
      if (typeof url === 'string' && url.includes('/api/tasks/poll')) {
        pollCount++;
        if (pollCount === 1) {
          return Promise.resolve({
            ok: true,
            json: () =>
              Promise.resolve({
                tasks: [
                  {
                    task_id: 'task-1',
                    owner: 'org',
                    repo: 'repo',
                    pr_number: 42,
                    diff_url: 'https://github.com/org/repo/pull/42.diff',
                    timeout_seconds: 300,
                    prompt: 'Review this',
                    role: 'review',
                  },
                ],
              }),
          });
        }
        // Exit on second poll
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
        });
      }
      if (typeof url === 'string' && url.includes('/claim')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ claimed: true }),
        });
      }
      // diff fetch
      if (typeof url === 'string' && url.includes('github.com')) {
        return Promise.resolve(new Response('diff content', { status: 200 }));
      }
      // result submission
      return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
    });

    const { reviewDeps, consumptionDeps } = makeDeps();

    const promise = startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      {
        pollIntervalMs: 100,
        maxConsecutiveErrors: 1,
      },
    );

    // Let the poll + claim cycle complete
    await vi.advanceTimersByTimeAsync(0);
    // Allow microtasks for claim/review to complete
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    // Find the claim request — github_username no longer sent (identity from OAuth)
    const claimCall = fetchCalls.find((c) => c.url.includes('/claim'));
    expect(claimCall).toBeDefined();
    expect(claimCall!.body.github_username).toBeUndefined();
  });

  it('does not send github_username in poll when not provided', async () => {
    let pollCount = 0;
    const fetchCalls: { url: string; body: Record<string, unknown> }[] = [];
    globalThis.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (init?.body) {
        fetchCalls.push({ url, body: JSON.parse(init.body as string) });
      }
      if (typeof url === 'string' && url.includes('/api/tasks/poll')) {
        pollCount++;
        if (pollCount >= 2) {
          return Promise.resolve({
            ok: false,
            status: 401,
            json: () =>
              Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
          });
        }
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({ tasks: [] }),
      });
    });

    const { reviewDeps, consumptionDeps } = makeDeps();

    const promise = startAgent(
      'test-agent',
      'https://api.test.com',
      { model: 'test-model', tool: 'test-tool' },
      reviewDeps,
      consumptionDeps,
      {
        pollIntervalMs: 100,
        maxConsecutiveErrors: 1,
      },
    );

    await vi.advanceTimersByTimeAsync(0);

    const pollCall = fetchCalls.find((c) => c.url.includes('/api/tasks/poll'));
    expect(pollCall).toBeDefined();
    expect(pollCall!.body.github_username).toBeUndefined();
    expect(pollCall!.body.roles).toBeUndefined();
    expect(pollCall!.body.synthesize_repos).toBeUndefined();

    // Let the loop exit
    await vi.advanceTimersByTimeAsync(200);
    await promise;
  });
});

describe('computeRoles', () => {
  it('returns ["review"] for review_only agent', () => {
    const agent: LocalAgentConfig = { model: 'claude-opus-4-6', tool: 'claude', review_only: true };
    expect(computeRoles(agent)).toEqual(['review']);
  });

  it('returns ["summary"] for synthesizer_only agent', () => {
    const agent: LocalAgentConfig = {
      model: 'claude-opus-4-6',
      tool: 'claude',
      synthesizer_only: true,
    };
    expect(computeRoles(agent)).toEqual(['summary']);
  });

  it('returns default roles for agent with neither flag', () => {
    const agent: LocalAgentConfig = { model: 'claude-opus-4-6', tool: 'claude' };
    expect(computeRoles(agent)).toEqual(['review', 'summary', 'implement', 'fix']);
  });

  it('returns explicit roles when roles field is set', () => {
    const agent: LocalAgentConfig = {
      model: 'claude-opus-4-6',
      tool: 'claude',
      roles: ['review', 'pr_dedup', 'issue_triage'],
    };
    expect(computeRoles(agent)).toEqual(['review', 'pr_dedup', 'issue_triage']);
  });

  it('roles field takes precedence over review_only', () => {
    const agent: LocalAgentConfig = {
      model: 'claude-opus-4-6',
      tool: 'claude',
      roles: ['review', 'summary', 'pr_dedup'],
      review_only: true,
    };
    expect(computeRoles(agent)).toEqual(['review', 'summary', 'pr_dedup']);
  });

  it('roles field takes precedence over synthesizer_only', () => {
    const agent: LocalAgentConfig = {
      model: 'claude-opus-4-6',
      tool: 'claude',
      roles: ['issue_triage'],
      synthesizer_only: true,
    };
    expect(computeRoles(agent)).toEqual(['issue_triage']);
  });

  it('falls back to review_only when roles is empty', () => {
    const agent: LocalAgentConfig = {
      model: 'claude-opus-4-6',
      tool: 'claude',
      roles: [],
      review_only: true,
    };
    expect(computeRoles(agent)).toEqual(['review']);
  });

  it('falls back to default when roles is undefined', () => {
    const agent: LocalAgentConfig = {
      model: 'claude-opus-4-6',
      tool: 'claude',
      roles: undefined,
    };
    expect(computeRoles(agent)).toEqual(['review', 'summary', 'implement', 'fix']);
  });
});

describe('isLongRunningRole', () => {
  it('returns true for review, summary, implement, fix', () => {
    expect(isLongRunningRole('review')).toBe(true);
    expect(isLongRunningRole('summary')).toBe(true);
    expect(isLongRunningRole('implement')).toBe(true);
    expect(isLongRunningRole('fix')).toBe(true);
  });

  it('returns false for short-running roles', () => {
    expect(isLongRunningRole('pr_triage')).toBe(false);
    expect(isLongRunningRole('issue_triage')).toBe(false);
    expect(isLongRunningRole('pr_dedup')).toBe(false);
    expect(isLongRunningRole('issue_dedup')).toBe(false);
    expect(isLongRunningRole('issue_review')).toBe(false);
  });
});

describe('createHeartbeatControl', () => {
  function makeLogger(): Logger {
    return {
      log: vi.fn(),
      logWarn: vi.fn(),
      logError: vi.fn(),
    } as unknown as Logger;
  }

  function makeClient(post: ReturnType<typeof vi.fn>): ApiClient {
    return { post } as unknown as ApiClient;
  }

  it('posts to /api/tasks/:id/heartbeat with agent_id and role', async () => {
    const post = vi.fn().mockResolvedValue({});
    const logger = makeLogger();

    const hb = createHeartbeatControl(
      makeClient(post),
      'task-abc',
      'agent-42',
      'review',
      logger,
      1000,
    );

    expect(hb.intervalMs).toBe(1000);
    await hb.callback();

    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/api/tasks/task-abc/heartbeat', {
      agent_id: 'agent-42',
      role: 'review',
    });
    expect(logger.logWarn).not.toHaveBeenCalled();
  });

  it('silently swallows 404 (old server) and logs the no-op once', async () => {
    const post = vi.fn().mockRejectedValue(new HttpError(404, 'not found'));
    const logger = makeLogger();

    const hb = createHeartbeatControl(makeClient(post), 'task-abc', 'agent-42', 'summary', logger);

    await expect(hb.callback()).resolves.toBeUndefined();
    await expect(hb.callback()).resolves.toBeUndefined();
    await expect(hb.callback()).resolves.toBeUndefined();

    // Post is still attempted each tick (server may be upgraded mid-run)
    expect(post).toHaveBeenCalledTimes(3);
    // ...but the operator-visible log only fires once
    expect(logger.log).toHaveBeenCalledTimes(1);
    expect(logger.log).toHaveBeenCalledWith(
      expect.stringContaining('heartbeat endpoint not available'),
    );
    expect(logger.logWarn).not.toHaveBeenCalled();
  });

  it('logs a warning but does not throw on transient 5xx errors', async () => {
    const post = vi.fn().mockRejectedValue(new HttpError(503, 'service unavailable'));
    const logger = makeLogger();

    const hb = createHeartbeatControl(
      makeClient(post),
      'task-abc',
      'agent-42',
      'implement',
      logger,
    );

    await expect(hb.callback()).resolves.toBeUndefined();
    expect(logger.logWarn).toHaveBeenCalledTimes(1);
    expect(logger.logWarn).toHaveBeenCalledWith(
      expect.stringContaining('Heartbeat failed for task task-abc'),
    );
  });

  it('logs a warning but does not throw on network errors', async () => {
    const post = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const logger = makeLogger();

    const hb = createHeartbeatControl(makeClient(post), 'task-abc', 'agent-42', 'fix', logger);

    await expect(hb.callback()).resolves.toBeUndefined();
    expect(logger.logWarn).toHaveBeenCalledTimes(1);
    expect(logger.logWarn).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
  });

  it('uses DEFAULT_HEARTBEAT_INTERVAL_MS when intervalMs is omitted', () => {
    const post = vi.fn();
    const logger = makeLogger();

    const hb = createHeartbeatControl(makeClient(post), 'task-abc', 'agent-42', 'review', logger);
    expect(hb.intervalMs).toBe(DEFAULT_HEARTBEAT_INTERVAL_MS);
  });
});
