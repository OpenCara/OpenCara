/**
 * Tests for agent.ts CLI command paths and startAgentByIndex.
 * These test the Commander.js action handler and the agent configuration
 * resolution logic that doesn't go through startAgent directly.
 *
 * Covers:
 * - startAgentByIndex: no command, invalid binary, router mode, OAuth auth
 * - agentCommand CLI action: --all, --agent, error paths
 * - startAgent without reviewDeps
 * - OAuth token integration (getValidToken, AuthError)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

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

// Mock all external dependencies before importing agent.ts
vi.mock('../config.js', () => ({
  loadConfig: vi.fn(() => ({
    platformUrl: 'http://test-server',
    maxDiffSizeKb: 100,
    maxConsecutiveErrors: 3,
    codebaseDir: null,
    agentCommand: 'echo test',
    agents: [
      { model: 'claude', tool: 'claude-cli', name: 'agent-0', command: 'echo review' },
      { model: 'gpt-4', tool: 'codex', name: 'agent-1', command: 'echo codex' },
    ],
    usageLimits: { maxReviewsPerDay: null, maxTokensPerDay: null, maxTokensPerReview: null },
  })),
  resolveCodebaseDir: vi.fn(() => null),
  DEFAULT_MAX_CONSECUTIVE_ERRORS: 10,
  CONFIG_DIR: '/tmp/test-opencara',
  ensureConfigDir: vi.fn(),
}));

vi.mock('../auth.js', () => ({
  getValidToken: vi.fn(async () => 'oauth-test-token'),
  loadAuth: vi.fn(() => ({
    access_token: 'oauth-test-token',
    refresh_token: 'refresh-token',
    expires_at: Date.now() + 3600000,
    github_username: 'testuser',
    github_user_id: 12345,
  })),
  AuthError: class AuthError extends Error {
    constructor(message: string) {
      super(message);
      this.name = 'AuthError';
    }
  },
}));

vi.mock('../tool-executor.js', () => ({
  executeTool: vi.fn(async () => ({
    stdout: '## Summary\nLGTM\n\n## Findings\nNo issues found.\n\n## Verdict\nAPPROVE',
    stderr: '',
    exitCode: 0,
    tokensUsed: 100,
    tokensParsed: true,
    tokenDetail: { input: 0, output: 100, total: 100, parsed: true },
  })),
  estimateTokens: (text: string) => Math.ceil(text.length / 4),
  validateCommandBinary: vi.fn(() => true),
  parseCommandTemplate: (cmd: string) => ({
    command: cmd.split(' ')[0],
    args: cmd.split(' ').slice(1),
  }),
  testCommand: vi.fn(async () => ({ ok: true, elapsedMs: 100 })),
}));

vi.mock('../usage-tracker.js', () => {
  class MockUsageTracker {
    recordReview = vi.fn();
    checkLimits = vi.fn(() => ({ allowed: true }));
    checkPerReviewLimit = vi.fn(() => ({ allowed: true }));
    formatSummary = vi.fn(() => 'Usage Summary:\n  Date: 2026-03-23\n  Reviews: 0');
    getToday = vi.fn(() => ({
      date: '2026-03-23',
      reviews: 0,
      tokens: { input: 0, output: 0, estimated: 0 },
    }));
    getData = vi.fn(() => ({ days: [] }));
  }
  return { UsageTracker: MockUsageTracker };
});

vi.mock('../router.js', () => {
  class MockRouterRelay {
    start = vi.fn();
    stop = vi.fn();
    buildReviewPrompt = vi.fn(() => 'review prompt');
    buildSummaryPrompt = vi.fn(() => 'summary prompt');
    sendPrompt = vi.fn(async () => '## Summary\nOK\n\n## Verdict\nAPPROVE');
    parseReviewResponse = vi.fn(() => ({ review: 'OK', verdict: 'approve' }));
  }
  return { RouterRelay: MockRouterRelay };
});

import { loadConfig } from '../config.js';
import { validateCommandBinary } from '../tool-executor.js';
import { getValidToken } from '../auth.js';

const originalFetch = globalThis.fetch;

describe('Agent CLI tests', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(process, 'on').mockImplementation(() => process);
    vi.mocked(validateCommandBinary).mockReturnValue(true);

    // Default fetch returns 401 to stop the poll loop quickly
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Unauthorized' } }),
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    process.exitCode = undefined;
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function advanceTime(totalMs: number, stepMs = 100): Promise<void> {
    const steps = Math.ceil(totalMs / stepMs);
    for (let i = 0; i < steps; i++) {
      await vi.advanceTimersByTimeAsync(stepMs);
    }
  }

  // ═══════════════════════════════════════════════════════════
  // startAgent without reviewDeps
  // ═══════════════════════════════════════════════════════════

  describe('startAgent without reviewDeps', () => {
    it('logs error and returns immediately', async () => {
      const { startAgent } = await import('../commands/agent.js');

      const promise = startAgent('no-deps-agent', 'http://test-server', {
        model: 'test',
        tool: 'test',
      });

      await advanceTime(100);
      await promise;

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('No review command configured. Set command in config.toml'),
      );
    });
  });

  // ═══════════════════════════════════════════════════════════
  // startAgentByIndex tests
  // ═══════════════════════════════════════════════════════════

  describe('startAgentByIndex via agentCommand', () => {
    it('returns null when no command configured', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        platformUrl: 'http://test-server',
        maxDiffSizeKb: 100,
        maxConsecutiveErrors: 3,
        codebaseDir: null,
        agentCommand: null,
        agents: [{ model: 'claude', tool: 'cli' }],
      });

      const { agentCommand } = await import('../commands/agent.js');
      const startCmd = agentCommand.commands.find((c) => c.name() === 'start');
      expect(startCmd).toBeDefined();

      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await startCmd!.parseAsync(['--agent', '0'], { from: 'user' });

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('No command configured'));
      exitSpy.mockRestore();
    });

    it('returns null when command binary not found', async () => {
      vi.mocked(validateCommandBinary).mockReturnValue(false);
      vi.mocked(loadConfig).mockReturnValue({
        platformUrl: 'http://test-server',
        maxDiffSizeKb: 100,
        maxConsecutiveErrors: 3,
        codebaseDir: null,
        agentCommand: 'nonexistent-tool review',
        agents: [{ model: 'claude', tool: 'cli', command: 'nonexistent-tool review' }],
      });

      const { agentCommand } = await import('../commands/agent.js');
      const startCmd = agentCommand.commands.find((c) => c.name() === 'start');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await startCmd!.parseAsync(['--agent', '0'], { from: 'user' });

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('Command binary not found'),
      );
      exitSpy.mockRestore();
    });

    it('starts all agents with --all flag', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        platformUrl: 'http://test-server',
        maxDiffSizeKb: 100,
        maxConsecutiveErrors: 3,
        codebaseDir: null,
        agentCommand: null,
        agents: [
          { model: 'claude', tool: 'cli', command: 'echo review' },
          { model: 'gpt-4', tool: 'codex', command: 'echo codex' },
        ],
      });

      const { agentCommand } = await import('../commands/agent.js');
      const startCmd = agentCommand.commands.find((c) => c.name() === 'start');

      void startCmd!.parseAsync(['--all'], { from: 'user' });

      // Advance timers to let agents start polling and fail with auth errors
      await advanceTime(5000);

      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('2 agent(s)'));
    });

    it('--all with no agents configured exits', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        platformUrl: 'http://test-server',
        maxDiffSizeKb: 100,
        maxConsecutiveErrors: 3,
        codebaseDir: null,
        agentCommand: null,
        agents: null,
      });

      const { agentCommand } = await import('../commands/agent.js');
      const startCmd = agentCommand.commands.find((c) => c.name() === 'start');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await startCmd!.parseAsync(['--all'], { from: 'user' });

      expect(console.error).toHaveBeenCalledWith('No agents configured in ~/.opencara/config.toml');
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('invalid agent index exits', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        platformUrl: 'http://test-server',
        maxDiffSizeKb: 100,
        maxConsecutiveErrors: 3,
        codebaseDir: null,
        agentCommand: null,
        agents: [{ model: 'claude', tool: 'cli', command: 'echo test' }],
      });

      const { agentCommand } = await import('../commands/agent.js');
      const startCmd = agentCommand.commands.find((c) => c.name() === 'start');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await startCmd!.parseAsync(['--agent', '5'], { from: 'user' });

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('--agent must be an integer between 0 and 0'),
      );
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('uses OAuth token for all agents', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        platformUrl: 'http://test-server',
        maxDiffSizeKb: 100,
        maxConsecutiveErrors: 3,
        codebaseDir: null,
        agentCommand: null,
        agents: [
          {
            model: 'claude',
            tool: 'cli',
            command: 'echo test',
          },
        ],
      });

      const { agentCommand } = await import('../commands/agent.js');
      const startCmd = agentCommand.commands.find((c) => c.name() === 'start');

      void startCmd!.parseAsync(['--agent', '0'], { from: 'user' });
      await advanceTime(3000);

      // The OAuth token should be used (verified by getValidToken being called)
      expect(getValidToken).toHaveBeenCalledWith('http://test-server');
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Agent'));
    });

    it('exits with error when not authenticated', async () => {
      const { AuthError } = await import('../auth.js');
      vi.mocked(getValidToken).mockRejectedValueOnce(
        new AuthError('Not authenticated. Run `opencara auth login` first.'),
      );

      vi.mocked(loadConfig).mockReturnValue({
        platformUrl: 'http://test-server',
        maxDiffSizeKb: 100,
        maxConsecutiveErrors: 3,
        codebaseDir: null,
        agentCommand: null,
        agents: [{ model: 'claude', tool: 'cli', command: 'echo test' }],
      });

      const { agentCommand } = await import('../commands/agent.js');
      const startCmd = agentCommand.commands.find((c) => c.name() === 'start');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await startCmd!.parseAsync(['--agent', '0'], { from: 'user' });

      expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Not authenticated'));
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('--all with some agents failing to start continues with others', async () => {
      // First agent has no command, second has a command
      vi.mocked(loadConfig).mockReturnValue({
        platformUrl: 'http://test-server',
        maxDiffSizeKb: 100,
        maxConsecutiveErrors: 3,
        codebaseDir: null,
        agentCommand: null,
        agents: [
          { model: 'claude', tool: 'cli' }, // no command → will fail
          { model: 'gpt-4', tool: 'codex', command: 'echo codex' },
        ],
      });

      const { agentCommand } = await import('../commands/agent.js');
      const startCmd = agentCommand.commands.find((c) => c.name() === 'start');

      void startCmd!.parseAsync(['--all'], { from: 'user' });
      await advanceTime(5000);

      expect(console.error).toHaveBeenCalledWith(
        expect.stringContaining('One or more agents could not start'),
      );
    });

    it('agent with router=true creates RouterRelay', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        platformUrl: 'http://test-server',
        maxDiffSizeKb: 100,
        maxConsecutiveErrors: 3,
        codebaseDir: null,
        agentCommand: null,
        agents: [
          {
            model: 'claude',
            tool: 'cli',
            command: 'echo test',
            router: true,
          },
        ],
      });

      const { agentCommand } = await import('../commands/agent.js');
      const startCmd = agentCommand.commands.find((c) => c.name() === 'start');

      void startCmd!.parseAsync(['--agent', '0'], { from: 'user' });
      await advanceTime(3000);

      // The agent should have started (router mode skips command dry-run)
      expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Agent'));
    });

    it('--all with zero startable agents exits', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        platformUrl: 'http://test-server',
        maxDiffSizeKb: 100,
        maxConsecutiveErrors: 3,
        codebaseDir: null,
        agentCommand: null,
        agents: [
          { model: 'claude', tool: 'cli' }, // no command
        ],
      });

      const { agentCommand } = await import('../commands/agent.js');
      const startCmd = agentCommand.commands.find((c) => c.name() === 'start');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await startCmd!.parseAsync(['--all'], { from: 'user' });

      expect(console.error).toHaveBeenCalledWith('No agents could be started. Check your config.');
      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('negative agent index is rejected', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        platformUrl: 'http://test-server',
        maxDiffSizeKb: 100,
        maxConsecutiveErrors: 3,
        codebaseDir: null,
        agentCommand: null,
        agents: [{ model: 'claude', tool: 'cli', command: 'echo test' }],
      });

      const { agentCommand } = await import('../commands/agent.js');
      const startCmd = agentCommand.commands.find((c) => c.name() === 'start');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await startCmd!.parseAsync(['--agent', '-1'], { from: 'user' });

      expect(exitSpy).toHaveBeenCalledWith(1);
      exitSpy.mockRestore();
    });

    it('no agents configured shows helpful message', async () => {
      vi.mocked(loadConfig).mockReturnValue({
        platformUrl: 'http://test-server',
        maxDiffSizeKb: 100,
        maxConsecutiveErrors: 3,
        codebaseDir: null,
        agentCommand: null,
        agents: null,
      });

      const { agentCommand } = await import('../commands/agent.js');
      const startCmd = agentCommand.commands.find((c) => c.name() === 'start');
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

      await startCmd!.parseAsync(['--agent', '0'], { from: 'user' });

      expect(console.error).toHaveBeenCalledWith('No agents configured in ~/.opencara/config.toml');
      exitSpy.mockRestore();
    });
  });
});
