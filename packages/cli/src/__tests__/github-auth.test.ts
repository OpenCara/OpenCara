import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'node:child_process';
import { resolveGithubToken, getGhCliToken, logAuthMethod } from '../github-auth.js';

describe('github-auth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('resolveGithubToken', () => {
    it('tier 1: GITHUB_TOKEN env var takes highest priority', () => {
      const result = resolveGithubToken('config-token', {
        getEnv: (key) => (key === 'GITHUB_TOKEN' ? 'env-token' : undefined),
        getGhToken: () => 'gh-token',
      });
      expect(result).toEqual({ token: 'env-token', method: 'env' });
    });

    it('tier 2: gh CLI token when no env var', () => {
      const result = resolveGithubToken('config-token', {
        getEnv: () => undefined,
        getGhToken: () => 'gh-token',
      });
      expect(result).toEqual({ token: 'gh-token', method: 'gh-cli' });
    });

    it('tier 3: config token when no env var and no gh CLI', () => {
      const result = resolveGithubToken('config-token', {
        getEnv: () => undefined,
        getGhToken: () => null,
      });
      expect(result).toEqual({ token: 'config-token', method: 'config' });
    });

    it('tier 4: no auth when nothing available', () => {
      const result = resolveGithubToken(null, {
        getEnv: () => undefined,
        getGhToken: () => null,
      });
      expect(result).toEqual({ token: null, method: 'none' });
    });

    it('tier 4: no auth when config token is undefined', () => {
      const result = resolveGithubToken(undefined, {
        getEnv: () => undefined,
        getGhToken: () => null,
      });
      expect(result).toEqual({ token: null, method: 'none' });
    });

    it('env var overrides gh CLI even when both available', () => {
      const result = resolveGithubToken(null, {
        getEnv: (key) => (key === 'GITHUB_TOKEN' ? 'env-token' : undefined),
        getGhToken: () => 'gh-token',
      });
      expect(result).toEqual({ token: 'env-token', method: 'env' });
    });

    it('gh CLI overrides config when env var absent', () => {
      const result = resolveGithubToken('config-token', {
        getEnv: () => undefined,
        getGhToken: () => 'gh-token',
      });
      expect(result).toEqual({ token: 'gh-token', method: 'gh-cli' });
    });

    it('empty env var is treated as absent', () => {
      const result = resolveGithubToken('config-token', {
        getEnv: (key) => (key === 'GITHUB_TOKEN' ? '' : undefined),
        getGhToken: () => null,
      });
      expect(result).toEqual({ token: 'config-token', method: 'config' });
    });

    it('uses real process.env when no deps provided', () => {
      const original = process.env.GITHUB_TOKEN;
      try {
        process.env.GITHUB_TOKEN = 'from-process-env';
        const result = resolveGithubToken(null);
        expect(result).toEqual({ token: 'from-process-env', method: 'env' });
      } finally {
        if (original === undefined) {
          delete process.env.GITHUB_TOKEN;
        } else {
          process.env.GITHUB_TOKEN = original;
        }
      }
    });

    it('null config token with no other sources returns none', () => {
      const result = resolveGithubToken(null, {
        getEnv: () => undefined,
        getGhToken: () => null,
      });
      expect(result).toEqual({ token: null, method: 'none' });
    });
  });

  describe('getGhCliToken', () => {
    it('returns token when gh auth token succeeds', () => {
      vi.mocked(execSync).mockReturnValue('gho_abc123\n');
      expect(getGhCliToken()).toBe('gho_abc123');
      expect(execSync).toHaveBeenCalledWith('gh auth token', {
        timeout: 5000,
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
    });

    it('trims whitespace from token', () => {
      vi.mocked(execSync).mockReturnValue('  gho_token_with_spaces  \n');
      expect(getGhCliToken()).toBe('gho_token_with_spaces');
    });

    it('returns null when gh is not installed', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('command not found: gh');
      });
      expect(getGhCliToken()).toBeNull();
    });

    it('returns null when gh auth token times out', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('TIMEOUT');
      });
      expect(getGhCliToken()).toBeNull();
    });

    it('returns null when gh auth token returns empty string', () => {
      vi.mocked(execSync).mockReturnValue('  \n');
      expect(getGhCliToken()).toBeNull();
    });

    it('returns null when gh is not authenticated', () => {
      vi.mocked(execSync).mockImplementation(() => {
        throw new Error('not logged in');
      });
      expect(getGhCliToken()).toBeNull();
    });
  });

  describe('logAuthMethod', () => {
    it('logs env var message', () => {
      const log = vi.fn();
      logAuthMethod('env', log);
      expect(log).toHaveBeenCalledWith('GitHub auth: using GITHUB_TOKEN env var');
    });

    it('logs gh CLI message', () => {
      const log = vi.fn();
      logAuthMethod('gh-cli', log);
      expect(log).toHaveBeenCalledWith('GitHub auth: using gh CLI token');
    });

    it('logs config message', () => {
      const log = vi.fn();
      logAuthMethod('config', log);
      expect(log).toHaveBeenCalledWith('GitHub auth: using config github_token');
    });

    it('logs none message', () => {
      const log = vi.fn();
      logAuthMethod('none', log);
      expect(log).toHaveBeenCalledWith('GitHub auth: none (public repos only)');
    });
  });
});
