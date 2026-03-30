import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import {
  checkRepoAccess,
  verifyRepoAccess,
  extractRepoUrls,
  buildBatchPollRequest,
  filterTasksForAgent,
  agentConfigToDescriptor,
  DEFAULT_RECHECK_INTERVAL,
  type AgentDescriptor,
} from '../batch-poll.js';
import { batchPollLoop, type ConsumptionDeps } from '../commands/agent.js';
import type { PollTask } from '@opencara/shared';
import type { LocalAgentConfig } from '../config.js';
import { createSessionTracker } from '../consumption.js';
import { createLogger, createAgentSession } from '../logger.js';

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
    execFileSync: vi.fn(() => {
      throw new Error('gh not available in test');
    }),
  };
});

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

const originalFetch = globalThis.fetch;

describe('checkRepoAccess', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns true for accessible repos (200)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await checkRepoAccess('owner/repo', 'token123', mockFetch);
    expect(result).toBe(true);
    expect(mockFetch).toHaveBeenCalledWith(
      'https://api.github.com/repos/owner/repo',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token123',
        }),
      }),
    );
  });

  it('returns false for inaccessible repos (404)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 404 });
    const result = await checkRepoAccess('owner/private-repo', 'token123', mockFetch);
    expect(result).toBe(false);
  });

  it('returns false for forbidden repos (403)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const result = await checkRepoAccess('owner/repo', 'token123', mockFetch);
    expect(result).toBe(false);
  });

  it('returns false on network error', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('Network error'));
    const result = await checkRepoAccess('owner/repo', 'token123', mockFetch);
    expect(result).toBe(false);
  });
});

describe('verifyRepoAccess', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('returns accessible and inaccessible repos', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('good-repo')) return Promise.resolve({ ok: true, status: 200 });
      return Promise.resolve({ ok: false, status: 404 });
    });
    const result = await verifyRepoAccess(
      ['owner/good-repo', 'owner/bad-repo'],
      'token123',
      mockFetch,
    );
    expect(result.accessible).toEqual(['owner/good-repo']);
    expect(result.inaccessible).toEqual(['owner/bad-repo']);
  });

  it('handles all accessible', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const result = await verifyRepoAccess(['a/b', 'c/d'], 'token', mockFetch);
    expect(result.accessible).toEqual(['a/b', 'c/d']);
    expect(result.inaccessible).toEqual([]);
  });

  it('handles all inaccessible', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 403 });
    const result = await verifyRepoAccess(['a/b', 'c/d'], 'token', mockFetch);
    expect(result.accessible).toEqual([]);
    expect(result.inaccessible).toEqual(['a/b', 'c/d']);
  });

  it('handles empty list', async () => {
    const mockFetch = vi.fn();
    const result = await verifyRepoAccess([], 'token', mockFetch);
    expect(result.accessible).toEqual([]);
    expect(result.inaccessible).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe('extractRepoUrls', () => {
  it('extracts unique repos from agent configs', () => {
    const agents: LocalAgentConfig[] = [
      {
        model: 'gpt-4',
        tool: 'claude',
        repos: { mode: 'whitelist', list: ['owner/repo1', 'owner/repo2'] },
      },
      {
        model: 'gpt-4',
        tool: 'claude',
        repos: { mode: 'whitelist', list: ['owner/repo2', 'owner/repo3'] },
      },
    ];
    const urls = extractRepoUrls(agents);
    expect(urls.sort()).toEqual(['owner/repo1', 'owner/repo2', 'owner/repo3']);
  });

  it('includes synthesize_repos', () => {
    const agents: LocalAgentConfig[] = [
      {
        model: 'gpt-4',
        tool: 'claude',
        synthesize_repos: { mode: 'whitelist', list: ['org/synth-repo'] },
      },
    ];
    const urls = extractRepoUrls(agents);
    expect(urls).toEqual(['org/synth-repo']);
  });

  it('returns empty for agents without explicit repo lists', () => {
    const agents: LocalAgentConfig[] = [
      { model: 'gpt-4', tool: 'claude', repos: { mode: 'public' } },
    ];
    const urls = extractRepoUrls(agents);
    expect(urls).toEqual([]);
  });

  it('ignores blacklist repos (only extracts whitelist)', () => {
    const agents: LocalAgentConfig[] = [
      {
        model: 'gpt-4',
        tool: 'claude',
        repos: { mode: 'blacklist', list: ['owner/excluded-repo'] },
      },
      {
        model: 'gpt-4',
        tool: 'claude',
        repos: { mode: 'whitelist', list: ['owner/included-repo'] },
      },
    ];
    const urls = extractRepoUrls(agents);
    expect(urls).toEqual(['owner/included-repo']);
  });
});

describe('buildBatchPollRequest', () => {
  it('builds request from agent descriptors', () => {
    const agents: AgentDescriptor[] = [
      {
        name: 'agent-1',
        agentId: 'uuid-1',
        roles: ['review', 'summary'],
        model: 'gpt-4',
        tool: 'claude',
      },
      {
        name: 'agent-2',
        agentId: 'uuid-2',
        roles: ['review'],
        model: 'gemini',
        tool: 'gemini',
        thinking: 'high',
      },
    ];
    const request = buildBatchPollRequest(agents);
    expect(request.agents).toHaveLength(2);
    expect(request.agents[0]).toEqual({
      agent_name: 'agent-1',
      roles: ['review', 'summary'],
      model: 'gpt-4',
      tool: 'claude',
    });
    expect(request.agents[1]).toEqual({
      agent_name: 'agent-2',
      roles: ['review'],
      model: 'gemini',
      tool: 'gemini',
      thinking: 'high',
    });
  });

  it('includes repo_filters when repos config is present', () => {
    const agents: AgentDescriptor[] = [
      {
        name: 'agent-1',
        agentId: 'uuid-1',
        roles: ['review'],
        model: 'gpt-4',
        tool: 'claude',
        repoConfig: { mode: 'whitelist', list: ['org/repo'] },
      },
    ];
    const request = buildBatchPollRequest(agents);
    expect(request.agents[0].repo_filters).toEqual([{ mode: 'whitelist', list: ['org/repo'] }]);
  });

  it('includes both repos and synthesize_repos in repo_filters', () => {
    const agents: AgentDescriptor[] = [
      {
        name: 'agent-1',
        agentId: 'uuid-1',
        roles: ['review', 'summary'],
        model: 'gpt-4',
        tool: 'claude',
        repoConfig: { mode: 'whitelist', list: ['org/repo1'] },
        synthesizeRepos: { mode: 'whitelist', list: ['org/repo2'] },
      },
    ];
    const request = buildBatchPollRequest(agents);
    expect(request.agents[0].repo_filters).toEqual([
      { mode: 'whitelist', list: ['org/repo1'] },
      { mode: 'whitelist', list: ['org/repo2'] },
    ]);
  });

  it('omits repo_filters when no repo config', () => {
    const agents: AgentDescriptor[] = [
      {
        name: 'agent-1',
        agentId: 'uuid-1',
        roles: ['review'],
        model: 'gpt-4',
        tool: 'claude',
      },
    ];
    const request = buildBatchPollRequest(agents);
    expect(request.agents[0].repo_filters).toBeUndefined();
  });
});

describe('filterTasksForAgent', () => {
  const makeTask = (overrides: Partial<PollTask> = {}): PollTask => ({
    task_id: 'task-1',
    owner: 'owner',
    repo: 'repo',
    pr_number: 1,
    diff_url: 'https://github.com/owner/repo/pull/1.diff',
    timeout_seconds: 300,
    prompt: 'Review this',
    role: 'review',
    ...overrides,
  });

  const makeAgent = (overrides: Partial<AgentDescriptor> = {}): AgentDescriptor => ({
    name: 'agent-1',
    agentId: 'uuid-1',
    roles: ['review'],
    model: 'gpt-4',
    tool: 'claude',
    ...overrides,
  });

  it('returns all tasks when no filters', () => {
    const tasks = [makeTask(), makeTask({ task_id: 'task-2' })];
    const agent = makeAgent();
    expect(filterTasksForAgent(tasks, agent)).toEqual(tasks);
  });

  it('filters by repo config (whitelist)', () => {
    const tasks = [
      makeTask({ owner: 'org', repo: 'allowed' }),
      makeTask({ task_id: 'task-2', owner: 'org', repo: 'blocked' }),
    ];
    const agent = makeAgent({
      repoConfig: { mode: 'whitelist', list: ['org/allowed'] },
    });
    const result = filterTasksForAgent(tasks, agent);
    expect(result).toHaveLength(1);
    expect(result[0].repo).toBe('allowed');
  });

  it('filters by diff size', () => {
    const tasks = [
      makeTask({ diff_size: 100 }), // ~12KB — under limit
      makeTask({ task_id: 'task-2', diff_size: 10000 }), // ~1200KB — over limit
    ];
    const agent = makeAgent();
    const result = filterTasksForAgent(tasks, agent, 500);
    expect(result).toHaveLength(1);
    expect(result[0].task_id).toBe('task-1');
  });

  it('filters by diff fetch failure count', () => {
    const tasks = [makeTask({ task_id: 'task-ok' }), makeTask({ task_id: 'task-failed' })];
    const agent = makeAgent();
    const diffFailCounts = new Map([['task-failed', 3]]);
    const result = filterTasksForAgent(tasks, agent, undefined, diffFailCounts, 3);
    expect(result).toHaveLength(1);
    expect(result[0].task_id).toBe('task-ok');
  });

  it('allows tasks under the max diff fetch attempts', () => {
    const tasks = [makeTask({ task_id: 'task-1' })];
    const agent = makeAgent();
    const diffFailCounts = new Map([['task-1', 2]]);
    const result = filterTasksForAgent(tasks, agent, undefined, diffFailCounts, 3);
    expect(result).toHaveLength(1);
  });

  it('filters by accessibleRepos set', () => {
    const tasks = [
      makeTask({ owner: 'org', repo: 'allowed' }),
      makeTask({ task_id: 'task-2', owner: 'org', repo: 'denied' }),
    ];
    const agent = makeAgent();
    const accessibleRepos = new Set(['org/allowed']);
    const result = filterTasksForAgent(tasks, agent, undefined, undefined, 3, accessibleRepos);
    expect(result).toHaveLength(1);
    expect(result[0].repo).toBe('allowed');
  });

  it('filters by synthesizeRepos config', () => {
    const tasks = [
      makeTask({ owner: 'org', repo: 'allowed' }),
      makeTask({ task_id: 'task-2', owner: 'other', repo: 'blocked' }),
    ];
    const agent = makeAgent({
      synthesizeRepos: { mode: 'whitelist', list: ['org/allowed'] },
    });
    const result = filterTasksForAgent(tasks, agent);
    expect(result).toHaveLength(1);
    expect(result[0].repo).toBe('allowed');
  });
});

describe('agentConfigToDescriptor', () => {
  it('converts a config to a descriptor', () => {
    const config: LocalAgentConfig = {
      model: 'gpt-4',
      tool: 'claude',
      name: 'my-agent',
      thinking: 'high',
      repos: { mode: 'whitelist', list: ['org/repo'] },
      synthesize_repos: { mode: 'public' },
    };
    const descriptor = agentConfigToDescriptor(config, 'uuid-1', 0, 'me', new Set(['org']));
    expect(descriptor.name).toBe('my-agent');
    expect(descriptor.agentId).toBe('uuid-1');
    expect(descriptor.roles).toEqual(['review', 'summary', 'implement', 'fix']);
    expect(descriptor.model).toBe('gpt-4');
    expect(descriptor.tool).toBe('claude');
    expect(descriptor.thinking).toBe('high');
    expect(descriptor.repoConfig).toEqual({ mode: 'whitelist', list: ['org/repo'] });
    expect(descriptor.synthesizeRepos).toEqual({ mode: 'public' });
    expect(descriptor.agentOwner).toBe('me');
    expect(descriptor.userOrgs).toEqual(new Set(['org']));
  });

  it('uses default name from index when name is absent', () => {
    const config: LocalAgentConfig = { model: 'gpt-4', tool: 'claude' };
    const descriptor = agentConfigToDescriptor(config, 'uuid-1', 2);
    expect(descriptor.name).toBe('agent[2]');
  });

  it('respects explicit roles config', () => {
    const config: LocalAgentConfig = {
      model: 'gpt-4',
      tool: 'claude',
      roles: ['review'],
    };
    const descriptor = agentConfigToDescriptor(config, 'uuid-1', 0);
    expect(descriptor.roles).toEqual(['review']);
  });
});

describe('DEFAULT_RECHECK_INTERVAL', () => {
  it('is 50', () => {
    expect(DEFAULT_RECHECK_INTERVAL).toBe(50);
  });
});

describe('batchPollLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(process, 'on').mockImplementation(() => process);
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function makeAgentState(overrides: Partial<AgentDescriptor> = {}) {
    const session = createSessionTracker();
    return {
      descriptor: {
        name: 'agent-1',
        agentId: 'uuid-1',
        roles: ['review'] as const,
        model: 'gpt-4',
        tool: 'claude',
        ...overrides,
      } as AgentDescriptor,
      reviewDeps: { commandTemplate: 'echo test', maxDiffSizeKb: 500 },
      consumptionDeps: { agentId: 'uuid-1', session } as ConsumptionDeps,
      logger: createLogger('agent-1'),
      agentSession: createAgentSession(),
      diffFailCounts: new Map<string, number>(),
    };
  }

  it('exits when aborted immediately', async () => {
    const controller = new AbortController();
    controller.abort();

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ assignments: {} }),
    });

    const { ApiClient } = await import('../http.js');
    const client = new ApiClient('http://localhost:8787');

    const state = makeAgentState();
    await batchPollLoop(client, [state], {
      pollIntervalMs: 1000,
      maxConsecutiveErrors: 3,
      signal: controller.signal,
    });
    // Should exit cleanly without errors
    expect(process.exitCode).toBeUndefined();
  });

  it('exits after max consecutive auth errors', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve({
        ok: false,
        status: 401,
        json: () => Promise.resolve({ error: { code: 'AUTH_FAILED', message: 'Unauthorized' } }),
      }),
    );

    const { ApiClient } = await import('../http.js');
    const client = new ApiClient('http://localhost:8787');
    const state = makeAgentState();

    const controller = new AbortController();
    const promise = batchPollLoop(client, [state], {
      pollIntervalMs: 100,
      maxConsecutiveErrors: 10,
      signal: controller.signal,
    });

    // Advance through 3 auth errors
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(200);
    }

    controller.abort();
    await promise;
    // Auth errors should set exit code 1
    expect(process.exitCode).toBe(1);
  });

  it('dispatches tasks from batch response', async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/poll/batch')) {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                assignments: {
                  'agent-1': {
                    tasks: [
                      {
                        task_id: 'task-1',
                        owner: 'org',
                        repo: 'repo',
                        pr_number: 1,
                        diff_url: 'https://github.com/org/repo/pull/1.diff',
                        timeout_seconds: 300,
                        prompt: 'Review this',
                        role: 'review',
                      },
                    ],
                  },
                },
              }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ assignments: {} }),
        });
      }
      // Claim endpoint
      if (typeof url === 'string' && url.includes('/claim')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ status: 'claimed' }),
        });
      }
      // Diff fetch (return 404 so it falls back)
      if (typeof url === 'string' && url.includes('github.com')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve('diff content'),
          headers: new Headers(),
          body: null,
        });
      }
      // Result submit
      if (typeof url === 'string' && url.includes('/result')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ status: 'ok' }),
        });
      }
      // reject
      if (typeof url === 'string' && url.includes('/reject')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ status: 'ok' }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
    });

    const { ApiClient } = await import('../http.js');
    const client = new ApiClient('http://localhost:8787');
    const state = makeAgentState();

    const controller = new AbortController();
    const promise = batchPollLoop(client, [state], {
      pollIntervalMs: 100,
      maxConsecutiveErrors: 3,
      signal: controller.signal,
    });

    // Let the first poll and task handling complete
    await vi.advanceTimersByTimeAsync(500);
    controller.abort();
    await promise;

    // Should have made at least one batch poll call
    expect(callCount).toBeGreaterThan(0);
  });

  it('handles empty assignments gracefully', async () => {
    globalThis.fetch = vi.fn().mockImplementation((url: string) => {
      if (typeof url === 'string' && url.includes('/poll/batch')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ assignments: {} }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
    });

    const { ApiClient } = await import('../http.js');
    const client = new ApiClient('http://localhost:8787');
    const state = makeAgentState();

    const controller = new AbortController();
    const promise = batchPollLoop(client, [state], {
      pollIntervalMs: 100,
      maxConsecutiveErrors: 3,
      signal: controller.signal,
    });

    await vi.advanceTimersByTimeAsync(300);
    controller.abort();
    await promise;

    // Should not have set any exit code (clean idle loop)
    expect(process.exitCode).toBeUndefined();
  });

  it('applies exponential backoff on consecutive errors', async () => {
    let pollCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(() => {
      pollCount++;
      return Promise.reject(new Error('Server unavailable'));
    });

    const { ApiClient } = await import('../http.js');
    const client = new ApiClient('http://localhost:8787');
    const state = makeAgentState();

    const controller = new AbortController();
    const promise = batchPollLoop(client, [state], {
      pollIntervalMs: 1000,
      maxConsecutiveErrors: 5,
      signal: controller.signal,
    });

    // Advance enough for a few error cycles with backoff
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(10000);
    }

    controller.abort();
    await promise;

    // Should have tried polling multiple times
    expect(pollCount).toBeGreaterThan(1);
  });

  it('exits after max consecutive errors', async () => {
    globalThis.fetch = vi.fn().mockImplementation(() => {
      return Promise.reject(new Error('Server unavailable'));
    });

    const { ApiClient } = await import('../http.js');
    const client = new ApiClient('http://localhost:8787');
    const state = makeAgentState();

    const controller = new AbortController();
    const promise = batchPollLoop(client, [state], {
      pollIntervalMs: 100,
      maxConsecutiveErrors: 3,
      signal: controller.signal,
    });

    // Advance enough time for 3+ errors
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(1000);
    }

    controller.abort();
    await promise;

    expect(process.exitCode).toBe(1);
  });
});
