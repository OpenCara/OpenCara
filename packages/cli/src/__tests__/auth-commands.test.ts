import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { runLogin, runStatus, runLogout, authCommand, defaultConfirm } from '../commands/auth.js';
import type { StoredAuth } from '../auth.js';
import type { CliConfig } from '../config.js';

const MOCK_AUTH: StoredAuth = {
  access_token: 'ghu_test_token',
  refresh_token: 'ghr_test_refresh',
  expires_at: Date.now() + 3600_000, // 1 hour from now
  github_username: 'octocat',
  github_user_id: 12345,
};

function makeConfig(overrides: Partial<CliConfig> = {}): CliConfig {
  return {
    platformUrl: 'https://api.opencara.com',
    maxDiffSizeKb: 100,
    maxConsecutiveErrors: 10,
    codebaseDir: null,
    agentCommand: null,
    agents: null,
    usageLimits: {
      maxTasksPerDay: null,
      maxTokensPerDay: null,
      maxTokensPerReview: null,
    },
    ...overrides,
  };
}

describe('auth commands', () => {
  let originalExitCode: number | undefined;

  beforeEach(() => {
    originalExitCode = process.exitCode;
    process.exitCode = undefined;
  });

  afterEach(() => {
    process.exitCode = originalExitCode;
  });

  describe('runLogin', () => {
    it('completes login when not already authenticated', async () => {
      const log = vi.fn();
      const logError = vi.fn();
      const loginFn = vi.fn().mockResolvedValue(MOCK_AUTH);

      await runLogin({
        loadAuthFn: () => null,
        loginFn,
        loadConfigFn: () => makeConfig(),
        getAuthFilePathFn: () => '/home/user/.opencara/auth.json',
        log,
        logError,
      });

      expect(loginFn).toHaveBeenCalledWith(
        'https://api.opencara.com',
        expect.objectContaining({ log: expect.any(Function) }),
      );
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Authenticated as'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('@octocat'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('12345'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('/home/user/.opencara/auth.json'));
    });

    it('prompts for re-authentication when already logged in and user confirms', async () => {
      const log = vi.fn();
      const loginFn = vi.fn().mockResolvedValue(MOCK_AUTH);
      const confirmFn = vi.fn().mockResolvedValue(true);

      await runLogin({
        loadAuthFn: () => MOCK_AUTH,
        loginFn,
        loadConfigFn: () => makeConfig(),
        getAuthFilePathFn: () => '/home/user/.opencara/auth.json',
        log,
        logError: vi.fn(),
        confirmFn,
      });

      expect(confirmFn).toHaveBeenCalledWith(expect.stringContaining('@octocat'));
      expect(confirmFn).toHaveBeenCalledWith(expect.stringContaining('Re-authenticate'));
      expect(loginFn).toHaveBeenCalled();
    });

    it('cancels when already logged in and user declines', async () => {
      const log = vi.fn();
      const loginFn = vi.fn();
      const confirmFn = vi.fn().mockResolvedValue(false);

      await runLogin({
        loadAuthFn: () => MOCK_AUTH,
        loginFn,
        loadConfigFn: () => makeConfig(),
        log,
        logError: vi.fn(),
        confirmFn,
      });

      expect(loginFn).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('Login cancelled.');
    });

    it('handles AuthError and sets non-zero exit code', async () => {
      const { AuthError } = await import('../auth.js');
      const logError = vi.fn();
      const loginFn = vi.fn().mockRejectedValue(new AuthError('Authorization timed out'));

      await runLogin({
        loadAuthFn: () => null,
        loginFn,
        loadConfigFn: () => makeConfig(),
        log: vi.fn(),
        logError,
      });

      expect(logError).toHaveBeenCalledWith(expect.stringContaining('Authorization timed out'));
      expect(process.exitCode).toBe(1);
    });

    it('re-throws non-AuthError errors', async () => {
      const loginFn = vi.fn().mockRejectedValue(new Error('network error'));

      await expect(
        runLogin({
          loadAuthFn: () => null,
          loginFn,
          loadConfigFn: () => makeConfig(),
          log: vi.fn(),
          logError: vi.fn(),
        }),
      ).rejects.toThrow('network error');
    });

    it('uses platform URL from config', async () => {
      const loginFn = vi.fn().mockResolvedValue(MOCK_AUTH);
      const config = makeConfig({ platformUrl: 'https://custom.platform.io' });

      await runLogin({
        loadAuthFn: () => null,
        loginFn,
        loadConfigFn: () => config,
        getAuthFilePathFn: () => '/home/user/.opencara/auth.json',
        log: vi.fn(),
        logError: vi.fn(),
      });

      expect(loginFn).toHaveBeenCalledWith(
        'https://custom.platform.io',
        expect.objectContaining({ log: expect.any(Function) }),
      );
    });
  });

  describe('runStatus', () => {
    it('shows authenticated status with expiry', () => {
      const log = vi.fn();
      const now = Date.now();
      const auth = { ...MOCK_AUTH, expires_at: now + 7 * 3600_000 }; // 7 hours from now

      runStatus({
        loadAuthFn: () => auth,
        getAuthFilePathFn: () => '/home/user/.opencara/auth.json',
        log,
        nowFn: () => now,
      });

      expect(log).toHaveBeenCalledWith(expect.stringContaining('Authenticated as'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('@octocat'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('12345'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Token expires'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('in 7 hours'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Auth file'));
      expect(process.exitCode).toBeUndefined();
    });

    it('shows not authenticated when no auth file', () => {
      const log = vi.fn();

      runStatus({
        loadAuthFn: () => null,
        log,
      });

      expect(log).toHaveBeenCalledWith(expect.stringContaining('Not authenticated'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('opencara auth login'));
      expect(process.exitCode).toBe(1);
    });

    it('shows expired token warning', () => {
      const log = vi.fn();
      const now = Date.now();
      const auth = { ...MOCK_AUTH, expires_at: now - 1000 }; // expired

      runStatus({
        loadAuthFn: () => auth,
        getAuthFilePathFn: () => '/home/user/.opencara/auth.json',
        log,
        nowFn: () => now,
      });

      expect(log).toHaveBeenCalledWith(expect.stringContaining('Token expired'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('@octocat'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('re-authenticate'));
      expect(process.exitCode).toBe(1);
    });

    it('shows time remaining in minutes when less than an hour', () => {
      const log = vi.fn();
      const now = Date.now();
      const auth = { ...MOCK_AUTH, expires_at: now + 30 * 60_000 }; // 30 minutes

      runStatus({
        loadAuthFn: () => auth,
        getAuthFilePathFn: () => '/home/user/.opencara/auth.json',
        log,
        nowFn: () => now,
      });

      expect(log).toHaveBeenCalledWith(expect.stringContaining('in 30 minutes'));
    });

    it('shows "in less than a minute" when very close to expiry', () => {
      const log = vi.fn();
      const now = Date.now();
      const auth = { ...MOCK_AUTH, expires_at: now + 30_000 }; // 30 seconds

      runStatus({
        loadAuthFn: () => auth,
        getAuthFilePathFn: () => '/home/user/.opencara/auth.json',
        log,
        nowFn: () => now,
      });

      expect(log).toHaveBeenCalledWith(expect.stringContaining('in less than a minute'));
    });

    it('shows singular "hour" when exactly 1 hour remaining', () => {
      const log = vi.fn();
      const now = Date.now();
      const auth = { ...MOCK_AUTH, expires_at: now + 3600_000 }; // exactly 1 hour

      runStatus({
        loadAuthFn: () => auth,
        getAuthFilePathFn: () => '/home/user/.opencara/auth.json',
        log,
        nowFn: () => now,
      });

      expect(log).toHaveBeenCalledWith(expect.stringContaining('in 1 hour'));
    });

    it('shows singular "minute" when exactly 1 minute remaining', () => {
      const log = vi.fn();
      const now = Date.now();
      const auth = { ...MOCK_AUTH, expires_at: now + 60_000 }; // exactly 1 minute

      runStatus({
        loadAuthFn: () => auth,
        getAuthFilePathFn: () => '/home/user/.opencara/auth.json',
        log,
        nowFn: () => now,
      });

      expect(log).toHaveBeenCalledWith(expect.stringContaining('in 1 minute'));
    });
  });

  describe('runLogout', () => {
    it('deletes auth and shows confirmation', () => {
      const log = vi.fn();
      const deleteAuthFn = vi.fn();

      runLogout({
        loadAuthFn: () => MOCK_AUTH,
        deleteAuthFn,
        getAuthFilePathFn: () => '/home/user/.opencara/auth.json',
        log,
      });

      expect(deleteAuthFn).toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Logged out'));
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Token removed'));
    });

    it('shows "Not logged in" when no auth exists', () => {
      const log = vi.fn();
      const deleteAuthFn = vi.fn();

      runLogout({
        loadAuthFn: () => null,
        deleteAuthFn,
        log,
      });

      expect(deleteAuthFn).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith('Not logged in.');
    });
  });

  describe('authCommand', () => {
    it('creates a command group with login, status, and logout subcommands', () => {
      const cmd = authCommand();
      expect(cmd.name()).toBe('auth');

      const subcommands = cmd.commands.map((c) => c.name());
      expect(subcommands).toContain('login');
      expect(subcommands).toContain('status');
      expect(subcommands).toContain('logout');
    });

    it('has proper descriptions', () => {
      const cmd = authCommand();
      expect(cmd.description()).toBe('Manage authentication');

      const login = cmd.commands.find((c) => c.name() === 'login');
      expect(login?.description()).toContain('Device Flow');

      const status = cmd.commands.find((c) => c.name() === 'status');
      expect(status?.description()).toContain('authentication status');

      const logout = cmd.commands.find((c) => c.name() === 'logout');
      expect(logout?.description()).toContain('Remove');
    });
  });

  describe('defaultConfirm', () => {
    let originalStdin: typeof process.stdin;

    beforeEach(() => {
      originalStdin = process.stdin;
    });

    afterEach(() => {
      Object.defineProperty(process, 'stdin', { value: originalStdin, writable: true });
    });

    it('returns false when stdin is not a TTY', async () => {
      const mockStdin = new PassThrough();
      Object.defineProperty(mockStdin, 'isTTY', { value: false });
      Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

      const result = await defaultConfirm('Continue?');
      expect(result).toBe(false);
    });

    it('returns true when user answers "y"', async () => {
      const mockStdin = new PassThrough();
      Object.defineProperty(mockStdin, 'isTTY', { value: true });
      Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

      const p = defaultConfirm('Continue?');
      // Simulate user typing "y" and pressing enter
      mockStdin.push('y\n');
      const result = await p;
      expect(result).toBe(true);
    });

    it('returns false when user answers "n"', async () => {
      const mockStdin = new PassThrough();
      Object.defineProperty(mockStdin, 'isTTY', { value: true });
      Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

      const p = defaultConfirm('Continue?');
      mockStdin.push('n\n');
      const result = await p;
      expect(result).toBe(false);
    });

    it('returns false when user presses enter without input', async () => {
      const mockStdin = new PassThrough();
      Object.defineProperty(mockStdin, 'isTTY', { value: true });
      Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

      const p = defaultConfirm('Continue?');
      mockStdin.push('\n');
      const result = await p;
      expect(result).toBe(false);
    });

    it('does not resolve to false from close event when question already answered', async () => {
      const mockStdin = new PassThrough();
      Object.defineProperty(mockStdin, 'isTTY', { value: true });
      Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

      const p = defaultConfirm('Continue?');
      // User answers "y" — question callback fires first, then close event fires
      mockStdin.push('y\n');
      const result = await p;
      // The answered guard ensures the close handler doesn't override the "y" answer
      expect(result).toBe(true);
    });

    it('returns false when stdin closes before user answers (race condition guard)', async () => {
      const mockStdin = new PassThrough();
      Object.defineProperty(mockStdin, 'isTTY', { value: true });
      Object.defineProperty(process, 'stdin', { value: mockStdin, writable: true });

      const p = defaultConfirm('Continue?');
      // Simulate stdin closing without any input (the npx race condition)
      // end() signals EOF which triggers readline 'close' event
      mockStdin.end();
      const result = await p;
      expect(result).toBe(false);
    });
  });
});
