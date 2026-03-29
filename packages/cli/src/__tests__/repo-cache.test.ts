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
  prWorktreeKey,
  getWorktreeRefCount,
  resetWorktreeRefCounts,
} from '../repo-cache.js';

describe('repo-cache', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetWorktreeRefCounts();
  });

  describe('prWorktreeKey', () => {
    it('generates pr-<number> key', () => {
      expect(prWorktreeKey(42)).toBe('pr-42');
      expect(prWorktreeKey(1)).toBe('pr-1');
      expect(prWorktreeKey(9999)).toBe('pr-9999');
    });
  });

  describe('ensureBareClone', () => {
    it('creates bare clone via gh when repo does not exist and gh is available', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = ensureBareClone('acme', 'widgets', '/tmp/repos', true);

      expect(result.bareRepoPath).toBe('/tmp/repos/acme/widgets.git');
      expect(result.cloned).toBe(true);

      const calls = vi.mocked(execFileSync).mock.calls;
      expect(calls.length).toBe(1);

      // gh repo clone --bare
      expect(calls[0][0]).toBe('gh');
      expect(calls[0][1]).toEqual([
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

      const result = ensureBareClone('acme', 'widgets', '/tmp/repos', true);

      expect(result.bareRepoPath).toBe('/tmp/repos/acme/widgets.git');
      expect(result.cloned).toBe(false);
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    });

    it('falls back to git clone when gh is not available', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = ensureBareClone('acme', 'widgets', '/tmp/repos', false);

      expect(result.cloned).toBe(true);

      const calls = vi.mocked(execFileSync).mock.calls;
      expect(calls[0][0]).toBe('git');
      expect(calls[0][1]).toEqual([
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

      ensureBareClone('acme', 'widgets', '/tmp/repos', true);

      expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/repos/acme', { recursive: true });
    });

    it('rejects invalid owner name', () => {
      expect(() => ensureBareClone('../etc', 'repo', '/tmp/repos', true)).toThrow(
        'disallowed characters',
      );
    });

    it('rejects invalid repo name', () => {
      expect(() => ensureBareClone('acme', '../../passwd', '/tmp/repos', true)).toThrow(
        'disallowed characters',
      );
    });
  });

  describe('fetchPRRef', () => {
    it('fetches PR ref with credential helper when gh is available', () => {
      vi.mocked(execFileSync).mockReturnValue('');

      fetchPRRef('/tmp/repos/acme/widgets.git', 42, true);

      const call = vi.mocked(execFileSync).mock.calls[0];
      expect(call[0]).toBe('git');
      expect(call[1]).toContain('fetch');
      expect(call[1]).toContain('--force');
      expect(call[1]).toContain('pull/42/head');
      expect(call[1]).toContain('-c');
      expect(call[1]).toContain('credential.helper=!gh auth git-credential');
    });

    it('fetches without credential helper when gh is not available', () => {
      vi.mocked(execFileSync).mockReturnValue('');

      fetchPRRef('/tmp/repos/acme/widgets.git', 42, false);

      const call = vi.mocked(execFileSync).mock.calls[0];
      expect(call[0]).toBe('git');
      const args = call[1] as string[];
      expect(args).toContain('fetch');
      expect(args).not.toContain('-c');
    });
  });

  describe('addWorktree', () => {
    it('creates worktree at correct path', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = addWorktree('/tmp/repos/acme/widgets.git', 'pr-42');

      expect(result).toBe('/tmp/repos/acme/widgets-worktrees/pr-42');
      expect(fs.mkdirSync).toHaveBeenCalledWith('/tmp/repos/acme/widgets-worktrees', {
        recursive: true,
      });

      const call = vi.mocked(execFileSync).mock.calls[0];
      expect(call[0]).toBe('git');
      expect(call[1]).toEqual([
        'worktree',
        'add',
        '--detach',
        '/tmp/repos/acme/widgets-worktrees/pr-42',
        'FETCH_HEAD',
      ]);
      expect(call[2]).toMatchObject({ cwd: '/tmp/repos/acme/widgets.git' });
    });

    it('reuses existing worktree directory without creating a new one', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = addWorktree('/tmp/repos/acme/widgets.git', 'pr-42');

      expect(result).toBe('/tmp/repos/acme/widgets-worktrees/pr-42');
      // Should NOT call git worktree add
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
      // Should NOT call mkdirSync
      expect(vi.mocked(fs.mkdirSync)).not.toHaveBeenCalled();
    });

    it('rejects invalid worktreeKey', () => {
      expect(() => addWorktree('/tmp/repos/acme/widgets.git', '../../etc')).toThrow(
        'disallowed characters',
      );
    });

    it('rejects worktreeKey with slashes', () => {
      expect(() => addWorktree('/tmp/repos/acme/widgets.git', 'a/b')).toThrow(
        'disallowed characters',
      );
    });
  });

  describe('removeWorktree', () => {
    it('removes worktree via git worktree remove', () => {
      vi.mocked(execFileSync).mockReturnValue('');

      removeWorktree('/tmp/repos/acme/widgets.git', '/tmp/repos/acme/widgets-worktrees/pr-42');

      const call = vi.mocked(execFileSync).mock.calls[0];
      expect(call[0]).toBe('git');
      expect(call[1]).toEqual([
        'worktree',
        'remove',
        '--force',
        '/tmp/repos/acme/widgets-worktrees/pr-42',
      ]);
      expect(call[2]).toMatchObject({ cwd: '/tmp/repos/acme/widgets.git' });
    });

    it('falls back to rmSync + prune on git worktree remove failure', () => {
      vi.mocked(execFileSync)
        .mockImplementationOnce(() => {
          throw new Error('worktree remove failed');
        })
        .mockReturnValue(''); // prune succeeds

      removeWorktree('/tmp/repos/acme/widgets.git', '/tmp/repos/acme/widgets-worktrees/pr-42');

      expect(fs.rmSync).toHaveBeenCalledWith('/tmp/repos/acme/widgets-worktrees/pr-42', {
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
        removeWorktree('/tmp/repos/acme/widgets.git', '/tmp/repos/acme/widgets-worktrees/pr-42'),
      ).not.toThrow();

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to clean up worktree'));
      warnSpy.mockRestore();
    });
  });

  describe('cleanupWorktree', () => {
    it('removes worktree when ref count is 0 (no prior checkout)', async () => {
      vi.mocked(execFileSync).mockReturnValue('');

      await cleanupWorktree(
        '/tmp/repos/acme/widgets.git',
        '/tmp/repos/acme/widgets-worktrees/pr-42',
      );

      const call = vi.mocked(execFileSync).mock.calls[0];
      expect(call[0]).toBe('git');
      expect(call[1]).toContain('worktree');
      expect(call[1]).toContain('remove');
    });

    it('removes worktree when ref count drops to 0', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      // Checkout once (ref count = 1)
      const result = await checkoutWorktree('acme', 'widgets', 42, '/tmp/repos');
      expect(getWorktreeRefCount(result.worktreePath)).toBe(1);

      vi.clearAllMocks();
      vi.mocked(execFileSync).mockReturnValue('');

      // Cleanup (ref count 1 → 0) — should remove
      await cleanupWorktree(result.bareRepoPath, result.worktreePath);

      expect(getWorktreeRefCount(result.worktreePath)).toBe(0);
      const removeCalls = vi
        .mocked(execFileSync)
        .mock.calls.filter((c) => Array.isArray(c[1]) && (c[1] as string[]).includes('remove'));
      expect(removeCalls).toHaveLength(1);
    });

    it('skips removal when ref count is still > 0', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      // Checkout twice (ref count = 2)
      const result1 = await checkoutWorktree('acme', 'widgets', 42, '/tmp/repos');

      // Second checkout — existsSync now returns true for the worktree dir
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const result2 = await checkoutWorktree('acme', 'widgets', 42, '/tmp/repos');

      expect(result1.worktreePath).toBe(result2.worktreePath);
      expect(getWorktreeRefCount(result1.worktreePath)).toBe(2);

      vi.clearAllMocks();
      vi.mocked(execFileSync).mockReturnValue('');

      // First cleanup (ref count 2 → 1) — should NOT remove
      await cleanupWorktree(result1.bareRepoPath, result1.worktreePath);

      expect(getWorktreeRefCount(result1.worktreePath)).toBe(1);
      // No git worktree remove calls
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();

      // Second cleanup (ref count 1 → 0) — should remove
      await cleanupWorktree(result1.bareRepoPath, result1.worktreePath);

      expect(getWorktreeRefCount(result1.worktreePath)).toBe(0);
      const removeCalls = vi
        .mocked(execFileSync)
        .mock.calls.filter((c) => Array.isArray(c[1]) && (c[1] as string[]).includes('remove'));
      expect(removeCalls).toHaveLength(1);
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

    it('cleans up map entry after last concurrent operation', async () => {
      // Run three concurrent operations on the same key
      const op1 = withRepoLock('acme/widgets', async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      const op2 = withRepoLock('acme/widgets', async () => {
        await new Promise((r) => setTimeout(r, 10));
      });
      const op3 = withRepoLock('acme/widgets', async () => {
        await new Promise((r) => setTimeout(r, 10));
      });

      await Promise.all([op1, op2, op3]);

      // After all complete, lock should be cleaned up
      // (We can't directly check the internal map, but verify lock is acquirable)
      const result = await withRepoLock('acme/widgets', () => 'ok');
      expect(result).toBe('ok');
    });
  });

  describe('checkoutWorktree', () => {
    it('uses pr-keyed worktree path instead of taskId', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = await checkoutWorktree('acme', 'widgets', 42, '/tmp/repos', 'task-abc');

      // Worktree is keyed by PR number, not taskId
      expect(result.worktreePath).toBe('/tmp/repos/acme/widgets-worktrees/pr-42');
      expect(result.bareRepoPath).toBe('/tmp/repos/acme/widgets.git');
      expect(result.cloned).toBe(true);

      const calls = vi.mocked(execFileSync).mock.calls;
      // 1: gh auth status (isGhAvailable — hoisted)
      // 2: gh repo clone --bare (ensureBareClone)
      // 3: git fetch (fetchPRRef)
      // 4: git worktree add (addWorktree)
      expect(calls.length).toBe(4);

      // Verify bare clone
      expect(calls[1][1]).toContain('--bare');

      // Verify fetch
      expect(calls[2][1]).toContain('pull/42/head');

      // Verify worktree add uses pr-42
      expect(calls[3][1]).toContain('worktree');
      expect(calls[3][1]).toContain('FETCH_HEAD');
      expect(calls[3][1]).toContain('/tmp/repos/acme/widgets-worktrees/pr-42');
    });

    it('increments ref count on checkout', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = await checkoutWorktree('acme', 'widgets', 42, '/tmp/repos');
      expect(getWorktreeRefCount(result.worktreePath)).toBe(1);
    });

    it('reuses worktree and increments ref count for same PR', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      const result1 = await checkoutWorktree('acme', 'widgets', 42, '/tmp/repos', 'task-1');

      // Now the worktree dir exists
      vi.mocked(fs.existsSync).mockReturnValue(true);

      const result2 = await checkoutWorktree('acme', 'widgets', 42, '/tmp/repos', 'task-2');

      // Same worktree path
      expect(result1.worktreePath).toBe(result2.worktreePath);
      expect(result1.worktreePath).toBe('/tmp/repos/acme/widgets-worktrees/pr-42');

      // Ref count is 2
      expect(getWorktreeRefCount(result1.worktreePath)).toBe(2);
    });

    it('creates separate worktrees for different PRs', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      const result1 = await checkoutWorktree('acme', 'widgets', 42, '/tmp/repos');
      const result2 = await checkoutWorktree('acme', 'widgets', 99, '/tmp/repos');

      expect(result1.worktreePath).toBe('/tmp/repos/acme/widgets-worktrees/pr-42');
      expect(result2.worktreePath).toBe('/tmp/repos/acme/widgets-worktrees/pr-99');
      expect(getWorktreeRefCount(result1.worktreePath)).toBe(1);
      expect(getWorktreeRefCount(result2.worktreePath)).toBe(1);
    });

    it('reuses existing bare clone', async () => {
      // HEAD exists → bare repo already present
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = await checkoutWorktree('acme', 'widgets', 42, '/tmp/repos', 'task-abc');

      expect(result.cloned).toBe(false);

      // Should not have a clone call
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
    });

    it('works without taskId parameter', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = await checkoutWorktree('acme', 'widgets', 42, '/tmp/repos');

      expect(result.worktreePath).toBe('/tmp/repos/acme/widgets-worktrees/pr-42');
      expect(getWorktreeRefCount(result.worktreePath)).toBe(1);
    });
  });
});
