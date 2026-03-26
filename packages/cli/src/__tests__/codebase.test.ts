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
  isGhAvailable,
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

  describe('isGhAvailable', () => {
    it('returns true when gh auth status succeeds', () => {
      vi.mocked(execFileSync).mockReturnValueOnce('');

      expect(isGhAvailable()).toBe(true);

      expect(vi.mocked(execFileSync)).toHaveBeenCalledWith(
        'gh',
        ['auth', 'status'],
        expect.objectContaining({ timeout: 10_000 }),
      );
    });

    it('returns false when gh is not installed', () => {
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw new Error('gh: command not found');
      });

      expect(isGhAvailable()).toBe(false);
    });

    it('returns false when gh is not authenticated', () => {
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw new Error('not logged in');
      });

      expect(isGhAvailable()).toBe(false);
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
    it('clones repo via gh repo clone on first review when gh available', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // Call 1: gh auth status (success), Call 2: gh repo clone, Call 3: git fetch, Call 4: git checkout
      vi.mocked(execFileSync).mockReturnValue('');

      const result = cloneOrUpdate('acme', 'widgets', 42, '/tmp/repos');

      expect(result.cloned).toBe(true);
      expect(result.localPath).toContain('acme/widgets');

      const calls = vi.mocked(execFileSync).mock.calls;
      expect(calls.length).toBe(4);

      // gh auth status
      expect(calls[0][0]).toBe('gh');
      expect(calls[0][1]).toEqual(['auth', 'status']);

      // gh repo clone (handles auth internally)
      expect(calls[1][0]).toBe('gh');
      expect(calls[1][1]).toEqual([
        'repo',
        'clone',
        'acme/widgets',
        expect.stringContaining('acme/widgets'),
        '--',
        '--depth',
        '1',
      ]);

      // Fetch PR ref with credential helper
      expect(calls[2][0]).toBe('git');
      expect(calls[2][1]).toContain('fetch');
      expect(calls[2][1]).toContain('--force');
      expect(calls[2][1]).toContain('pull/42/head');
      expect(calls[2][1]).toContain('-c');
      expect(calls[2][1]).toContain('credential.helper=!gh auth git-credential');

      // Checkout FETCH_HEAD
      expect(calls[3][0]).toBe('git');
      expect(calls[3][1]).toContain('checkout');
      expect(calls[3][1]).toContain('FETCH_HEAD');
    });

    it('does not call mkdirSync when using gh repo clone (gh creates dir)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      cloneOrUpdate('acme', 'widgets', 42, '/tmp/repos');

      expect(fs.mkdirSync).not.toHaveBeenCalled();
    });

    it('only fetches on subsequent reviews (.git dir exists)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = cloneOrUpdate('acme', 'widgets', 99, '/tmp/repos');

      expect(result.cloned).toBe(false);
      expect(result.localPath).toContain('acme/widgets');

      // Should NOT clone
      expect(fs.mkdirSync).not.toHaveBeenCalled();

      // gh auth status + fetch + checkout
      const calls = vi.mocked(execFileSync).mock.calls;
      expect(calls.length).toBe(3);
      expect(calls[0][0]).toBe('gh');
      expect(calls[0][1]).toEqual(['auth', 'status']);
      expect(calls[1][0]).toBe('git');
      expect(calls[1][1]).toContain('fetch');
      expect(calls[1][1]).toContain('pull/99/head');
      expect(calls[2][0]).toBe('git');
      expect(calls[2][1]).toContain('checkout');
    });

    it('uses gh repo clone for authentication — no token in URL or headers', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      cloneOrUpdate('acme', 'private-repo', 1, '/tmp/repos');

      const calls = vi.mocked(execFileSync).mock.calls;

      // gh repo clone call
      const ghCloneCall = calls[1];
      expect(ghCloneCall[0]).toBe('gh');
      expect(ghCloneCall[1]).toContain('clone');

      // No token in any args
      const allArgs = calls.flatMap((c) => (c[1] as string[]) || []);
      expect(allArgs.some((a) => a.includes('x-access-token'))).toBe(false);
      expect(allArgs.some((a) => a.includes('http.extraHeader'))).toBe(false);
    });

    it('falls back to unauthenticated git clone when gh is not available', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // gh auth status fails, then git commands succeed
      vi.mocked(execFileSync)
        .mockImplementationOnce(() => {
          throw new Error('gh: command not found');
        })
        .mockReturnValue('');

      cloneOrUpdate('acme', 'public-repo', 1, '/tmp/repos');

      const calls = vi.mocked(execFileSync).mock.calls;

      // Should have mkdirSync for unauthenticated path
      expect(fs.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('acme'), {
        recursive: true,
      });

      // Clone uses plain git (no gh, no credential helper)
      const cloneCall = calls[1];
      expect(cloneCall[0]).toBe('git');
      const cloneArgs = cloneCall[1] as string[];
      expect(cloneArgs).toContain('clone');
      expect(cloneArgs.some((a) => a.includes('github.com/acme/public-repo.git'))).toBe(true);
      expect(cloneArgs).not.toContain('-c');

      // Fetch also has no credential helper
      const fetchCall = calls[2];
      const fetchArgs = fetchCall[1] as string[];
      expect(fetchArgs).not.toContain('-c');
      expect(fetchArgs).toContain('fetch');
    });

    it('sanitizes tokens from git error messages', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync)
        .mockReturnValueOnce('') // gh auth status
        .mockImplementation(() => {
          throw new Error(
            'fatal: could not access https://github.com/acme/repo.git with Authorization: Bearer ghp_secret123',
          );
        });

      expect(() => cloneOrUpdate('acme', 'repo', 1, '/tmp/repos')).toThrow();
      // Should NOT contain the actual token
      try {
        // Reset mocks for the second call
        vi.mocked(execFileSync)
          .mockReset()
          .mockReturnValueOnce('') // gh auth status
          .mockImplementation(() => {
            throw new Error(
              'fatal: could not access https://github.com/acme/repo.git with Authorization: Bearer ghp_secret123',
            );
          });
        cloneOrUpdate('acme', 'repo', 1, '/tmp/repos');
      } catch (err) {
        expect((err as Error).message).not.toContain('ghp_secret123');
        expect((err as Error).message).toContain('Authorization: ***');
      }
    });

    it('throws on gh repo clone failure', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync)
        .mockReturnValueOnce('') // gh auth status
        .mockImplementation(() => {
          throw new Error('fatal: repository not found');
        });

      expect(() => cloneOrUpdate('bad', 'repo', 1, '/tmp/repos')).toThrow(
        'fatal: repository not found',
      );
    });

    it('throws on git fetch failure', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync)
        .mockReturnValueOnce('') // gh auth status
        .mockImplementation(() => {
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

      // calls[0] = gh auth status, calls[1] = fetch, calls[2] = checkout
      const fetchCall = vi.mocked(execFileSync).mock.calls[1];
      expect(fetchCall[2]).toMatchObject({ cwd: expect.stringContaining('acme/widgets') });

      const checkoutCall = vi.mocked(execFileSync).mock.calls[2];
      expect(checkoutCall[2]).toMatchObject({ cwd: expect.stringContaining('acme/widgets') });
    });

    it('uses task-specific subdirectory when taskId is provided', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = cloneOrUpdate('acme', 'widgets', 42, '/tmp/repos', 'task-abc-123');

      expect(result.localPath).toBe('/tmp/repos/acme/widgets/task-abc-123');
      expect(result.cloned).toBe(true);

      // gh repo clone is called with the task-specific path
      const ghCloneCall = vi.mocked(execFileSync).mock.calls[1];
      expect(ghCloneCall[1]).toContain('/tmp/repos/acme/widgets/task-abc-123');
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

      const result1 = cloneOrUpdate('acme', 'widgets', 10, '/tmp/repos', 'task-1');

      vi.mocked(execFileSync).mockReset().mockReturnValue('');
      vi.mocked(fs.existsSync).mockReturnValue(false);

      const result2 = cloneOrUpdate('acme', 'widgets', 20, '/tmp/repos', 'task-2');

      expect(result1.localPath).toBe('/tmp/repos/acme/widgets/task-1');
      expect(result2.localPath).toBe('/tmp/repos/acme/widgets/task-2');
      expect(result1.localPath).not.toBe(result2.localPath);
    });

    it('rejects taskId with path traversal', () => {
      expect(() => cloneOrUpdate('acme', 'widgets', 1, '/tmp/repos', '../../etc')).toThrow(
        'disallowed characters',
      );
    });

    it('rejects taskId with slashes', () => {
      expect(() => cloneOrUpdate('acme', 'widgets', 1, '/tmp/repos', 'a/b')).toThrow(
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
