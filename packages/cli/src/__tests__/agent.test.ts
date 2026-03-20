import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { startAgent, type ConsumptionDeps } from '../commands/agent.js';
import type { ReviewExecutorDeps } from '../review.js';
import { createSessionTracker } from '../consumption.js';

const originalFetch = globalThis.fetch;

function makeDeps(): { reviewDeps: ReviewExecutorDeps; consumptionDeps: ConsumptionDeps } {
  const session = createSessionTracker();
  return {
    reviewDeps: { commandTemplate: 'echo test', maxDiffSizeKb: 500 },
    consumptionDeps: { agentId: 'test-agent', limits: null, session },
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
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('exits after 3 consecutive auth failures', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'Unauthorized' }),
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

    expect(console.error).toHaveBeenCalledWith('Authentication failed repeatedly. Exiting.');
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
    expect(console.error).not.toHaveBeenCalledWith('Authentication failed repeatedly. Exiting.');
    // Agent is still running (callCount > 3 means it got past the errors)
    expect(callCount).toBeGreaterThan(3);
  });

  it('logs model and tool on startup', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: 'Unauthorized' }),
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

    expect(console.log).toHaveBeenCalledWith('Model: claude-sonnet-4-6 | Tool: claude');
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
        // Return claimed: false so the loop doesn't try to fetch a diff
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ claimed: false, reason: 'test' }),
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
          json: () => Promise.resolve({ error: 'Unauthorized' }),
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
          json: () => Promise.resolve({ error: 'Unauthorized' }),
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

  it('resets auth counter on successful poll', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      callCount++;
      // 2 auth failures, then success, then 2 more auth failures
      if (callCount <= 2 || (callCount >= 4 && callCount <= 5)) {
        return Promise.resolve({
          ok: false,
          status: 401,
          json: () => Promise.resolve({ error: 'Unauthorized' }),
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
    expect(console.error).not.toHaveBeenCalledWith('Authentication failed repeatedly. Exiting.');
    expect(callCount).toBeGreaterThanOrEqual(5);
  });
});
