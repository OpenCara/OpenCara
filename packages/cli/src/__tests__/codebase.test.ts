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
    rmSync: vi.fn(),
  };
});

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import {
  cloneOrUpdate,
  cleanupTaskDir,
  buildCloneUrl,
  buildAuthArgs,
  validatePathSegment,
} from '../codebase.js';

describe('codebase', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('buildCloneUrl', () => {
    it('builds public HTTPS URL without embedded credentials', () => {
      expect(buildCloneUrl('acme', 'widgets')).toBe('https://github.com/acme/widgets.git');
    });
  });

  describe('buildAuthArgs', () => {
    it('returns empty array when no token is provided', () => {
      expect(buildAuthArgs()).toEqual([]);
      expect(buildAuthArgs(null)).toEqual([]);
      expect(buildAuthArgs(undefined)).toEqual([]);
    });

    it('returns http.extraHeader config args with Bearer token', () => {
      expect(buildAuthArgs('ghp_abc123')).toEqual([
        '-c',
        'http.extraHeader=Authorization: Bearer ghp_abc123',
      ]);
    });

    it('does not embed token in a URL', () => {
      const args = buildAuthArgs('ghp_secret');
      const joined = args.join(' ');
      expect(joined).not.toContain('github.com');
      expect(joined).not.toContain('@');
      expect(joined).toContain('Authorization: Bearer ghp_secret');
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

    it('uses http.extraHeader for auth when token is provided', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      cloneOrUpdate('acme', 'private-repo', 1, '/tmp/repos', 'ghp_token');

      const cloneCall = vi.mocked(execFileSync).mock.calls[0];
      const cloneArgs = cloneCall[1] as string[];
      // Token must NOT be in the URL
      expect(cloneArgs.some((a) => a.includes('x-access-token:ghp_token@'))).toBe(false);
      // Token must be passed via http.extraHeader
      expect(cloneArgs).toContain('-c');
      expect(
        cloneArgs.some((a) => a.includes('http.extraHeader=Authorization: Bearer ghp_token')),
      ).toBe(true);
      // Clone URL must be plain HTTPS
      expect(cloneArgs.some((a) => a.includes('github.com/acme/private-repo.git'))).toBe(true);
    });

    it('uses plain URL without auth args when no token', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      cloneOrUpdate('acme', 'public-repo', 1, '/tmp/repos');

      const cloneCall = vi.mocked(execFileSync).mock.calls[0];
      const cloneArgs = cloneCall[1] as string[];
      expect(cloneArgs.some((a) => a.includes('x-access-token'))).toBe(false);
      expect(cloneArgs).not.toContain('-c');
      expect(cloneArgs.some((a) => a.includes('github.com/acme/public-repo.git'))).toBe(true);
    });

    it('sanitizes tokens from git error messages', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error(
          'fatal: could not access https://github.com/acme/repo.git with Authorization: Bearer ghp_secret123',
        );
      });

      expect(() => cloneOrUpdate('acme', 'repo', 1, '/tmp/repos', 'ghp_secret123')).toThrow();
      // Should NOT contain the actual token
      try {
        cloneOrUpdate('acme', 'repo', 1, '/tmp/repos', 'ghp_secret123');
      } catch (err) {
        expect((err as Error).message).not.toContain('ghp_secret123');
        expect((err as Error).message).toContain('Authorization: ***');
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

    it('uses task-specific subdirectory when taskId is provided', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = cloneOrUpdate('acme', 'widgets', 42, '/tmp/repos', null, 'task-abc-123');

      expect(result.localPath).toBe('/tmp/repos/acme/widgets/task-abc-123');
      expect(result.cloned).toBe(true);

      // Should create task-specific dir
      expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/repos/acme/widgets/task-abc-123', {
        recursive: true,
      });
    });

    it('uses owner/repo path without taskId (backward compatible)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = cloneOrUpdate('acme', 'widgets', 42, '/tmp/repos');

      expect(result.localPath).toBe('/tmp/repos/acme/widgets');
    });

    it('isolates concurrent tasks with different taskIds', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      const result1 = cloneOrUpdate('acme', 'widgets', 10, '/tmp/repos', null, 'task-1');
      const result2 = cloneOrUpdate('acme', 'widgets', 20, '/tmp/repos', null, 'task-2');

      expect(result1.localPath).toBe('/tmp/repos/acme/widgets/task-1');
      expect(result2.localPath).toBe('/tmp/repos/acme/widgets/task-2');
      expect(result1.localPath).not.toBe(result2.localPath);
    });

    it('rejects taskId with path traversal', () => {
      expect(() => cloneOrUpdate('acme', 'widgets', 1, '/tmp/repos', null, '../../etc')).toThrow(
        'disallowed characters',
      );
    });

    it('rejects taskId with slashes', () => {
      expect(() => cloneOrUpdate('acme', 'widgets', 1, '/tmp/repos', null, 'a/b')).toThrow(
        'disallowed characters',
      );
    });
  });

  describe('cleanupTaskDir', () => {
    it('removes the task directory', () => {
      cleanupTaskDir('/tmp/repos/acme/widgets/task-123');

      expect(fs.rmSync).toHaveBeenCalledWith('/tmp/repos/acme/widgets/task-123', {
        recursive: true,
        force: true,
      });
    });

    it('ignores ENOENT errors silently', () => {
      vi.mocked(fs.rmSync).mockImplementation(() => {
        throw Object.assign(new Error('No such file'), { code: 'ENOENT' });
      });

      expect(() => cleanupTaskDir('/tmp/repos/acme/widgets/task-123')).not.toThrow();
    });

    it('warns on non-ENOENT errors but does not throw', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fs.rmSync).mockImplementation(() => {
        throw Object.assign(new Error('Permission denied'), { code: 'EPERM' });
      });

      expect(() => cleanupTaskDir('/tmp/repos/acme/widgets/task-123')).not.toThrow();
      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Permission denied'));
      warnSpy.mockRestore();
    });

    it('refuses to delete shallow paths', () => {
      cleanupTaskDir('/tmp');

      expect(fs.rmSync).not.toHaveBeenCalled();
    });

    it('refuses to delete relative paths', () => {
      cleanupTaskDir('repos/acme/widgets');

      expect(fs.rmSync).not.toHaveBeenCalled();
    });
  });
});
