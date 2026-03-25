import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../auth.js', () => ({
  loadAuth: vi.fn(() => null),
}));

import {
  runStatus,
  agentRoleLabel,
  resolveToolBinary,
  checkConnectivity,
  fetchMetrics,
} from '../commands/status.js';
import type { CliConfig } from '../config.js';
import { DEFAULT_PLATFORM_URL } from '../config.js';
import { loadAuth } from '../auth.js';

function makeConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    platformUrl: DEFAULT_PLATFORM_URL,
    apiKey: null,
    maxDiffSizeKb: 100,
    maxConsecutiveErrors: 10,
    codebaseDir: null,
    agentCommand: null,
    agents: null,
    usageLimits: {
      maxReviewsPerDay: null,
      maxTokensPerDay: null,
      maxTokensPerReview: null,
    },
    ...overrides,
  };
}

function makeFetchOk(body: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve(body),
  }) as unknown as typeof fetch;
}

/** Create a fetch mock that returns health OK then metrics with tasks. */
function makeFetchHealthAndMetrics(metrics: {
  tasks: { total: number; pending: number; reviewing: number; completed: number; failed: number };
}): typeof fetch {
  let callCount = 0;
  return vi.fn().mockImplementation(() => {
    callCount++;
    if (callCount === 1) {
      // /health
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ status: 'ok' }),
      });
    }
    // /metrics
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () => Promise.resolve(metrics),
    });
  }) as unknown as typeof fetch;
}

function makeFetchFail(status: number): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({}),
  }) as unknown as typeof fetch;
}

function makeFetchError(message: string): typeof fetch {
  return vi.fn().mockRejectedValue(new Error(message)) as unknown as typeof fetch;
}

describe('agentRoleLabel', () => {
  it('returns reviewer+synthesizer by default', () => {
    expect(agentRoleLabel({ model: 'm', tool: 't' })).toBe('reviewer+synthesizer');
  });

  it('returns reviewer only when review_only is set', () => {
    expect(agentRoleLabel({ model: 'm', tool: 't', review_only: true })).toBe('reviewer only');
  });

  it('returns synthesizer only when synthesizer_only is set', () => {
    expect(agentRoleLabel({ model: 'm', tool: 't', synthesizer_only: true })).toBe(
      'synthesizer only',
    );
  });
});

describe('resolveToolBinary', () => {
  it('resolves known tool to binary name', () => {
    expect(resolveToolBinary('claude')).toBe('claude');
    expect(resolveToolBinary('codex')).toBe('codex');
    expect(resolveToolBinary('gemini')).toBe('gemini');
    expect(resolveToolBinary('qwen')).toBe('qwen');
  });

  it('falls back to tool name for unknown tools', () => {
    expect(resolveToolBinary('unknown-tool')).toBe('unknown-tool');
  });
});

describe('checkConnectivity', () => {
  it('returns ok with elapsed ms on success', async () => {
    const fetchFn = makeFetchOk({ status: 'ok' });
    const result = await checkConnectivity('https://example.com', fetchFn);
    expect(result.ok).toBe(true);
    expect(result.ms).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
  });

  it('returns error on non-200 response', async () => {
    const fetchFn = makeFetchFail(503);
    const result = await checkConnectivity('https://example.com', fetchFn);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('HTTP 503');
  });

  it('returns error on network failure', async () => {
    const fetchFn = makeFetchError('ECONNREFUSED');
    const result = await checkConnectivity('https://example.com', fetchFn);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('ECONNREFUSED');
  });
});

describe('fetchMetrics', () => {
  it('returns metrics on success', async () => {
    const metrics = { tasks: { total: 5, pending: 3, reviewing: 1, completed: 0, failed: 1 } };
    const fetchFn = makeFetchOk(metrics);
    const result = await fetchMetrics('https://example.com', fetchFn);
    expect(result).toEqual(metrics);
  });

  it('returns null on non-200', async () => {
    const fetchFn = makeFetchFail(500);
    const result = await fetchMetrics('https://example.com', fetchFn);
    expect(result).toBeNull();
  });

  it('returns null on network error', async () => {
    const fetchFn = makeFetchError('ECONNREFUSED');
    const result = await fetchMetrics('https://example.com', fetchFn);
    expect(result).toBeNull();
  });

  it('returns null on invalid response shape', async () => {
    const fetchFn = makeFetchOk({ unexpected: 'data' });
    const result = await fetchMetrics('https://example.com', fetchFn);
    expect(result).toBeNull();
  });
});

describe('runStatus', () => {
  let lines: string[];
  let log: (msg: string) => void;

  beforeEach(() => {
    lines = [];
    log = (msg: string) => lines.push(msg);
  });

  it('shows full status with agents and connectivity', async () => {
    vi.mocked(loadAuth).mockReturnValue({
      access_token: 'test-token',
      refresh_token: 'refresh',
      expires_at: Date.now() + 3600000,
      github_username: 'octocat',
      github_user_id: 123,
    });

    const config = makeConfig({
      agents: [
        { model: 'claude-sonnet-4-6', tool: 'claude' },
        { model: 'gemini-2.5-pro', tool: 'gemini', review_only: true },
      ],
    });
    const metrics = { tasks: { total: 5, pending: 3, reviewing: 1, completed: 0, failed: 1 } };
    const fetchFn = makeFetchOk(metrics);

    await runStatus({
      loadConfigFn: () => config,
      fetchFn,
      validateBinaryFn: () => true,
      log,
    });

    const output = lines.join('\n');
    expect(output).toContain('OpenCara Agent Status');
    expect(output).toContain('octocat');
    expect(output).toContain('OK');
    expect(output).toContain('2 configured');
    expect(output).toContain('claude-sonnet-4-6/claude');
    expect(output).toContain('reviewer+synthesizer');
    expect(output).toContain('gemini-2.5-pro/gemini');
    expect(output).toContain('reviewer only');
    expect(output).toContain('executable');
    expect(output).toContain('3 pending');
    expect(output).toContain('1 reviewing');
    expect(output).toContain('1 failed');
  });

  it('shows named agent instead of model/tool', async () => {
    const config = makeConfig({
      agents: [{ model: 'claude-sonnet-4-6', tool: 'claude', name: 'my-reviewer' }],
    });
    const fetchFn = makeFetchHealthAndMetrics({
      tasks: { total: 0, pending: 0, reviewing: 0, completed: 0, failed: 0 },
    });

    await runStatus({
      loadConfigFn: () => config,
      fetchFn,
      validateBinaryFn: () => true,
      log,
    });

    const output = lines.join('\n');
    expect(output).toContain('my-reviewer');
  });

  it('shows connectivity failure', async () => {
    const config = makeConfig();
    const fetchFn = makeFetchError('ECONNREFUSED');

    await runStatus({
      loadConfigFn: () => config,
      fetchFn,
      validateBinaryFn: () => true,
      log,
    });

    const output = lines.join('\n');
    expect(output).toContain('Connection failed: ECONNREFUSED');
    expect(output).toContain('skipped (no connectivity)');
  });

  it('shows missing binary warning', async () => {
    const config = makeConfig({
      agents: [{ model: 'gemini-2.5-pro', tool: 'gemini' }],
    });
    const fetchFn = makeFetchHealthAndMetrics({
      tasks: { total: 0, pending: 0, reviewing: 0, completed: 0, failed: 0 },
    });

    await runStatus({
      loadConfigFn: () => config,
      fetchFn,
      validateBinaryFn: () => false,
      log,
    });

    const output = lines.join('\n');
    expect(output).toContain('gemini not found');
  });

  it('shows "No agents configured" when agents is null', async () => {
    const config = makeConfig({ agents: null });
    const fetchFn = makeFetchHealthAndMetrics({
      tasks: { total: 0, pending: 0, reviewing: 0, completed: 0, failed: 0 },
    });

    await runStatus({
      loadConfigFn: () => config,
      fetchFn,
      validateBinaryFn: () => true,
      log,
    });

    const output = lines.join('\n');
    expect(output).toContain('No agents configured');
  });

  it('shows "No agents configured" when agents is empty array', async () => {
    const config = makeConfig({ agents: [] });
    const fetchFn = makeFetchHealthAndMetrics({
      tasks: { total: 0, pending: 0, reviewing: 0, completed: 0, failed: 0 },
    });

    await runStatus({
      loadConfigFn: () => config,
      fetchFn,
      validateBinaryFn: () => true,
      log,
    });

    const output = lines.join('\n');
    expect(output).toContain('No agents configured');
  });

  it('shows not authenticated when no auth', async () => {
    vi.mocked(loadAuth).mockReturnValue(null);

    const config = makeConfig();
    const fetchFn = makeFetchHealthAndMetrics({
      tasks: { total: 0, pending: 0, reviewing: 0, completed: 0, failed: 0 },
    });

    await runStatus({
      loadConfigFn: () => config,
      fetchFn,
      validateBinaryFn: () => true,
      log,
    });

    const output = lines.join('\n');
    expect(output).toContain('not authenticated');
  });

  it('handles metrics fetch failure when connected', async () => {
    const config = makeConfig();
    // First call (health) succeeds, second call (metrics) fails
    let callCount = 0;
    const fetchFn = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({}) });
      }
      return Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
    }) as unknown as typeof fetch;

    await runStatus({
      loadConfigFn: () => config,
      fetchFn,
      validateBinaryFn: () => true,
      log,
    });

    const output = lines.join('\n');
    expect(output).toContain('Could not fetch metrics');
  });

  it('uses custom command for binary check when agent has command override', async () => {
    const config = makeConfig({
      agents: [{ model: 'claude-sonnet-4-6', tool: 'claude', command: '/usr/local/bin/my-claude' }],
    });
    const fetchFn = makeFetchHealthAndMetrics({
      tasks: { total: 0, pending: 0, reviewing: 0, completed: 0, failed: 0 },
    });
    const validateBinaryFn = vi.fn().mockReturnValue(true);

    await runStatus({
      loadConfigFn: () => config,
      fetchFn,
      validateBinaryFn,
      log,
    });

    expect(validateBinaryFn).toHaveBeenCalledWith('/usr/local/bin/my-claude');
  });

  it('uses registry command template when agent has no command override', async () => {
    const config = makeConfig({
      agents: [{ model: 'claude-sonnet-4-6', tool: 'claude' }],
    });
    const fetchFn = makeFetchHealthAndMetrics({
      tasks: { total: 0, pending: 0, reviewing: 0, completed: 0, failed: 0 },
    });
    const validateBinaryFn = vi.fn().mockReturnValue(true);

    await runStatus({
      loadConfigFn: () => config,
      fetchFn,
      validateBinaryFn,
      log,
    });

    // Should use the registry command template for 'claude'
    expect(validateBinaryFn).toHaveBeenCalledWith(
      "claude --model ${MODEL} --allowedTools '*' --print",
    );
  });
});
