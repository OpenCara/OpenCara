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
  ensureBareClone,
  fetchPRRef,
  addWorktree,
  removeWorktree,
  cleanupWorktree,
  checkoutWorktree,
  withRepoLock,
} from '../repo-cache.js';

describe('repo-cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('ensureBareClone', () => {
    it('creates bare clone via gh when repo does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      // Call 1: gh auth status, Call 2: gh repo clone
      vi.mocked(execFileSync).mockReturnValue('');

      const result = ensureBareClone('acme', 'widgets', '/tmp/repos');

      expect(result.bareRepoPath).toBe('/tmp/repos/acme/widgets.git');
      expect(result.cloned).toBe(true);

      const calls = vi.mocked(execFileSync).mock.calls;
      expect(calls.length).toBe(2);

      // gh auth status
      expect(calls[0][0]).toBe('gh');
      expect(calls[0][1]).toEqual(['auth', 'status']);

      // gh repo clone --bare
      expect(calls[1][0]).toBe('gh');
      expect(calls[1][1]).toEqual([
        'repo',
        'clone',
        'acme/widgets',
        '/tmp/repos/acme/widgets.git',
        '--',
        '--bare',
        '--filter=blob:none',
      ]);
    });

    it('skips clone when bare repo already exists (HEAD file present)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result = ensureBareClone('acme', 'widgets', '/tmp/repos');

      expect(result.bareRepoPath).toBe('/tmp/repos/acme/widgets.git');
      expect(result.cloned).toBe(false);
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    });

    it('falls back to git clone when gh is not available', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync)
        .mockImplementationOnce(() => {
          throw new Error('gh: command not found');
        })
        .mockReturnValue('');

      const result = ensureBareClone('acme', 'widgets', '/tmp/repos');

      expect(result.cloned).toBe(true);

      const calls = vi.mocked(execFileSync).mock.calls;
      // Call 1: gh auth status (fails), Call 2: git clone --bare
      expect(calls[1][0]).toBe('git');
      expect(calls[1][1]).toEqual([
        'clone',
        '--bare',
        '--filter=blob:none',
        'https://github.com/acme/widgets.git',
        '/tmp/repos/acme/widgets.git',
      ]);
    });

    it('creates parent directory', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      ensureBareClone('acme', 'widgets', '/tmp/repos');

      expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/repos/acme', { recursive: true });
    });

    it('rejects invalid owner name', () => {
      expect(() => ensureBareClone('../etc', 'repo', '/tmp/repos')).toThrow(
        'disallowed characters',
      );
    });

    it('rejects invalid repo name', () => {
      expect(() => ensureBareClone('acme', '../../passwd', '/tmp/repos')).toThrow(
        'disallowed characters',
      );
    });
  });

  describe('fetchPRRef', () => {
    it('fetches PR ref with credential helper when gh is available', () => {
      vi.mocked(execFileSync).mockReturnValue('');

      fetchPRRef('/tmp/repos/acme/widgets.git', 42);

      const calls = vi.mocked(execFileSync).mock.calls;
      // Call 1: gh auth status, Call 2: git fetch
      expect(calls[1][0]).toBe('git');
      expect(calls[1][1]).toContain('fetch');
      expect(calls[1][1]).toContain('--force');
      expect(calls[1][1]).toContain('pull/42/head');
      expect(calls[1][1]).toContain('-c');
      expect(calls[1][1]).toContain('credential.helper=!gh auth git-credential');
    });

    it('fetches without credential helper when gh is not available', () => {
      vi.mocked(execFileSync)
        .mockImplementationOnce(() => {
          throw new Error('gh: command not found');
        })
        .mockReturnValue('');

      fetchPRRef('/tmp/repos/acme/widgets.git', 42);

      const fetchCall = vi.mocked(execFileSync).mock.calls[1];
      expect(fetchCall[0]).toBe('git');
      const args = fetchCall[1] as string[];
      expect(args).toContain('fetch');
      expect(args).not.toContain('-c');
    });
  });

  describe('addWorktree', () => {
    it('creates worktree at correct path', () => {
      vi.mocked(execFileSync).mockReturnValue('');

      const result = addWorktree('/tmp/repos/acme/widgets.git', 'task-123');

      expect(result).toBe('/tmp/repos/acme/widgets-worktrees/task-123');
      expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/repos/acme/widgets-worktrees', {
        recursive: true,
      });

      const call = vi.mocked(execFileSync).mock.calls[0];
      expect(call[0]).toBe('git');
      expect(call[1]).toEqual([
        'worktree',
        'add',
        '--detach',
        '/tmp/repos/acme/widgets-worktrees/task-123',
        'FETCH_HEAD',
      ]);
      expect(call[2]).toMatchObject({ cwd: '/tmp/repos/acme/widgets.git' });
    });

    it('rejects invalid taskId', () => {
      expect(() => addWorktree('/tmp/repos/acme/widgets.git', '../../etc')).toThrow(
        'disallowed characters',
      );
    });

    it('rejects taskId with slashes', () => {
      expect(() => addWorktree('/tmp/repos/acme/widgets.git', 'a/b')).toThrow(
        'disallowed characters',
      );
    });
  });

  describe('removeWorktree', () => {
    it('removes worktree via git worktree remove', () => {
      vi.mocked(execFileSync).mockReturnValue('');

      removeWorktree('/tmp/repos/acme/widgets.git', '/tmp/repos/acme/widgets-worktrees/task-123');

      const call = vi.mocked(execFileSync).mock.calls[0];
      expect(call[0]).toBe('git');
      expect(call[1]).toEqual([
        'worktree',
        'remove',
        '--force',
        '/tmp/repos/acme/widgets-worktrees/task-123',
      ]);
      expect(call[2]).toMatchObject({ cwd: '/tmp/repos/acme/widgets.git' });
    });

    it('falls back to rmSync + prune on git worktree remove failure', () => {
      vi.mocked(execFileSync)
        .mockImplementationOnce(() => {
          throw new Error('worktree remove failed');
        })
        .mockReturnValue(''); // prune succeeds

      removeWorktree('/tmp/repos/acme/widgets.git', '/tmp/repos/acme/widgets-worktrees/task-123');

      expect(fs.rmSync).toHaveBeenCalledWith('/tmp/repos/acme/widgets-worktrees/task-123', {
        recursive: true,
        force: true,
      });

      // prune call
      const pruneCall = vi.mocked(execFileSync).mock.calls[1];
      expect(pruneCall[0]).toBe('git');
      expect(pruneCall[1]).toEqual(['worktree', 'prune']);
    });

    it('warns but does not throw when all cleanup fails', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('failed');
      });
      vi.mocked(fs.rmSync).mockImplementation(() => {
        throw new Error('rmSync failed');
      });

      expect(() =>
        removeWorktree('/tmp/repos/acme/widgets.git', '/tmp/repos/acme/widgets-worktrees/task-123'),
      ).not.toThrow();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to clean up worktree'));
      warnSpy.mockRestore();
    });
  });

  describe('cleanupWorktree', () => {
    it('delegates to removeWorktree', () => {
      vi.mocked(execFileSync).mockReturnValue('');

      cleanupWorktree('/tmp/repos/acme/widgets.git', '/tmp/repos/acme/widgets-worktrees/task-123');

      const call = vi.mocked(execFileSync).mock.calls[0];
      expect(call[0]).toBe('git');
      expect(call[1]).toContain('worktree');
      expect(call[1]).toContain('remove');
    });
  });

  describe('withRepoLock', () => {
    it('serializes concurrent operations on the same repo', async () => {
      const order: number[] = [];

      const op1 = withRepoLock('acme/widgets', async () => {
        order.push(1);
        await new Promise((r) => setTimeout(r, 50));
        order.push(2);
      });

      const op2 = withRepoLock('acme/widgets', async () => {
        order.push(3);
      });

      await Promise.all([op1, op2]);

      // op2 should wait for op1 to finish
      expect(order).toEqual([1, 2, 3]);
    });

    it('allows parallel operations on different repos', async () => {
      const order: string[] = [];

      const op1 = withRepoLock('acme/widgets', async () => {
        order.push('a-start');
        await new Promise((r) => setTimeout(r, 50));
        order.push('a-end');
      });

      const op2 = withRepoLock('acme/other', async () => {
        order.push('b-start');
        await new Promise((r) => setTimeout(r, 10));
        order.push('b-end');
      });

      await Promise.all([op1, op2]);

      // Both should start before either finishes
      expect(order.indexOf('a-start')).toBeLessThan(order.indexOf('a-end'));
      expect(order.indexOf('b-start')).toBeLessThan(order.indexOf('b-end'));
      // b should finish before a (shorter delay)
      expect(order.indexOf('b-end')).toBeLessThan(order.indexOf('a-end'));
    });

    it('releases lock even if operation throws', async () => {
      await expect(
        withRepoLock('acme/widgets', () => {
          throw new Error('boom');
        }),
      ).rejects.toThrow('boom');

      // Should be able to acquire lock again
      const result = await withRepoLock('acme/widgets', () => 42);
      expect(result).toBe(42);
    });
  });

  describe('checkoutWorktree', () => {
    it('performs full checkout flow: bare clone + fetch + worktree add', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = await checkoutWorktree('acme', 'widgets', 42, '/tmp/repos', 'task-abc');

      expect(result.worktreePath).toBe('/tmp/repos/acme/widgets-worktrees/task-abc');
      expect(result.bareRepoPath).toBe('/tmp/repos/acme/widgets.git');
      expect(result.cloned).toBe(true);

      const calls = vi.mocked(execFileSync).mock.calls;
      // 1: gh auth status (ensureBareClone)
      // 2: gh repo clone --bare (ensureBareClone)
      // 3: gh auth status (fetchPRRef)
      // 4: git fetch (fetchPRRef)
      // 5: git worktree add (addWorktree)
      expect(calls.length).toBe(5);

      // Verify bare clone
      expect(calls[1][1]).toContain('--bare');

      // Verify fetch
      expect(calls[3][1]).toContain('pull/42/head');

      // Verify worktree add
      expect(calls[4][1]).toContain('worktree');
      expect(calls[4][1]).toContain('FETCH_HEAD');
    });

    it('reuses existing bare clone', async () => {
      // HEAD exists → bare repo already present
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = await checkoutWorktree('acme', 'widgets', 42, '/tmp/repos', 'task-abc');

      expect(result.cloned).toBe(false);

      // Should not have a clone call — only gh auth status (for fetch) + fetch + worktree add
      const calls = vi.mocked(execFileSync).mock.calls;
      const cloneCalls = calls.filter(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('clone'),
      );
      expect(cloneCalls).toHaveLength(0);
    });

    it('validates path segments', async () => {
      await expect(checkoutWorktree('../etc', 'repo', 1, '/tmp/repos', 'task-1')).rejects.toThrow(
        'disallowed characters',
      );

      await expect(
        checkoutWorktree('acme', '../../passwd', 1, '/tmp/repos', 'task-1'),
      ).rejects.toThrow('disallowed characters');

      await expect(checkoutWorktree('acme', 'repo', 1, '/tmp/repos', '../../etc')).rejects.toThrow(
        'disallowed characters',
      );
    });
  });
});
