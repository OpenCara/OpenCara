import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import { cloneOrUpdate, buildCloneUrl, validatePathSegment } from '../codebase.js';

describe('codebase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildCloneUrl', () => {
    it('builds public URL without token', () => {
      expect(buildCloneUrl('acme', 'widgets')).toBe('https://github.com/acme/widgets.git');
    });

    it('builds public URL when token is null', () => {
      expect(buildCloneUrl('acme', 'widgets', null)).toBe('https://github.com/acme/widgets.git');
    });

    it('builds authenticated URL with token', () => {
      expect(buildCloneUrl('acme', 'widgets', 'ghp_abc123')).toBe(
        'https://x-access-token:ghp_abc123@github.com/acme/widgets.git',
      );
    });
  });

  describe('validatePathSegment', () => {
    it('accepts valid owner/repo names', () => {
      expect(() => validatePathSegment('acme', 'owner')).not.toThrow();
      expect(() => validatePathSegment('my-org', 'owner')).not.toThrow();
      expect(() => validatePathSegment('repo.js', 'repo')).not.toThrow();
      expect(() => validatePathSegment('my_repo', 'repo')).not.toThrow();
    });

    it('rejects path traversal', () => {
      expect(() => validatePathSegment('..', 'owner')).toThrow('disallowed characters');
      expect(() => validatePathSegment('../etc', 'owner')).toThrow('disallowed characters');
    });

    it('rejects slashes', () => {
      expect(() => validatePathSegment('org/repo', 'owner')).toThrow('disallowed characters');
      expect(() => validatePathSegment('a\\b', 'repo')).toThrow('disallowed characters');
    });

    it('rejects empty string', () => {
      expect(() => validatePathSegment('', 'owner')).toThrow('disallowed characters');
    });
  });

  describe('cloneOrUpdate', () => {
    it('clones repo on first review (no .git dir)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = cloneOrUpdate('acme', 'widgets', 42, '/tmp/repos');

      expect(result.cloned).toBe(true);
      expect(result.localPath).toContain('acme/widgets');

      // Should create parent dir
      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('acme'), {
        recursive: true,
      });

      // Should run clone, then fetch, then checkout
      const calls = vi.mocked(execFileSync).mock.calls;
      expect(calls.length).toBe(3);

      // Clone call
      expect(calls[0][0]).toBe('git');
      expect(calls[0][1]).toContain('clone');
      expect(calls[0][1]).toContain('--depth');
      expect(calls[0][1]).toContain('1');

      // Fetch PR ref (with --force)
      expect(calls[1][0]).toBe('git');
      expect(calls[1][1]).toContain('fetch');
      expect(calls[1][1]).toContain('--force');
      expect(calls[1][1]).toContain('pull/42/head');

      // Checkout FETCH_HEAD
      expect(calls[2][0]).toBe('git');
      expect(calls[2][1]).toContain('checkout');
      expect(calls[2][1]).toContain('FETCH_HEAD');
    });

    it('only fetches on subsequent reviews (.git dir exists)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = cloneOrUpdate('acme', 'widgets', 99, '/tmp/repos');

      expect(result.cloned).toBe(false);
      expect(result.localPath).toContain('acme/widgets');

      // Should NOT create dir or clone
      expect(fs.mkdirSync).not.toHaveBeenCalled();

      // Only fetch + checkout
      const calls = vi.mocked(execFileSync).mock.calls;
      expect(calls.length).toBe(2);
      expect(calls[0][1]).toContain('fetch');
      expect(calls[0][1]).toContain('pull/99/head');
      expect(calls[1][1]).toContain('checkout');
    });

    it('uses authenticated URL when token is provided', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      cloneOrUpdate('acme', 'private-repo', 1, '/tmp/repos', 'ghp_token');

      const cloneCall = vi.mocked(execFileSync).mock.calls[0];
      const cloneArgs = cloneCall[1] as string[];
      expect(cloneArgs.some((a) => a.includes('x-access-token:ghp_token@'))).toBe(true);
    });

    it('uses public URL when no token', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      cloneOrUpdate('acme', 'public-repo', 1, '/tmp/repos');

      const cloneCall = vi.mocked(execFileSync).mock.calls[0];
      const cloneArgs = cloneCall[1] as string[];
      expect(cloneArgs.some((a) => a.includes('x-access-token'))).toBe(false);
      expect(cloneArgs.some((a) => a.includes('github.com/acme/public-repo.git'))).toBe(true);
    });

    it('sanitizes tokens from git error messages', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error(
          'fatal: could not access https://x-access-token:ghp_secret123@github.com/acme/repo.git',
        );
      });

      expect(() => cloneOrUpdate('acme', 'repo', 1, '/tmp/repos', 'ghp_secret123')).toThrow(
        'x-access-token:***@',
      );
      // Should NOT contain the actual token
      try {
        cloneOrUpdate('acme', 'repo', 1, '/tmp/repos', 'ghp_secret123');
      } catch (err) {
        expect((err as Error).message).not.toContain('ghp_secret123');
      }
    });

    it('throws on git clone failure', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('fatal: repository not found');
      });

      expect(() => cloneOrUpdate('bad', 'repo', 1, '/tmp/repos')).toThrow(
        'fatal: repository not found',
      );
    });

    it('throws on git fetch failure', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('fatal: could not read from remote');
      });

      expect(() => cloneOrUpdate('acme', 'widgets', 1, '/tmp/repos')).toThrow(
        'fatal: could not read from remote',
      );
    });

    it('rejects invalid owner name', () => {
      expect(() => cloneOrUpdate('../etc', 'repo', 1, '/tmp/repos')).toThrow(
        'disallowed characters',
      );
    });

    it('rejects invalid repo name', () => {
      expect(() => cloneOrUpdate('acme', '../../passwd', 1, '/tmp/repos')).toThrow(
        'disallowed characters',
      );
    });

    it('passes cwd to fetch and checkout commands', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockReturnValue('');

      cloneOrUpdate('acme', 'widgets', 5, '/tmp/repos');

      const fetchCall = vi.mocked(execFileSync).mock.calls[0];
      expect(fetchCall[2]).toMatchObject({ cwd: expect.stringContaining('acme/widgets') });

      const checkoutCall = vi.mocked(execFileSync).mock.calls[1];
      expect(checkoutCall[2]).toMatchObject({ cwd: expect.stringContaining('acme/widgets') });
    });
  });
});
