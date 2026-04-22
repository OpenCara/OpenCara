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
  getRepoSize,
  parseDiffPaths,
  buildSparsePatterns,
  configureSparseCheckout,
  deriveDefaultBranch,
  diffFromWorktree,
} from '../repo-cache.js';
import { DiffTooLargeError } from '../review.js';

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

      const result = addWorktree('/tmp/repos/acme/widgets.git', 'pr-42', 'abc123');

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
        'abc123',
      ]);
      expect(call[2]).toMatchObject({ cwd: '/tmp/repos/acme/widgets.git' });
    });

    it('reuses existing worktree directory without creating a new one', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = addWorktree('/tmp/repos/acme/widgets.git', 'pr-42', 'abc123');

      expect(result).toBe('/tmp/repos/acme/widgets-worktrees/pr-42');
      // Should NOT call git worktree add
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
      // Should NOT call mkdirSync
      expect(vi.mocked(fs.mkdirSync)).not.toHaveBeenCalled();
    });

    it('rejects invalid worktreeKey', () => {
      expect(() => addWorktree('/tmp/repos/acme/widgets.git', '../../etc', 'abc123')).toThrow(
        'disallowed characters',
      );
    });

    it('rejects worktreeKey with slashes', () => {
      expect(() => addWorktree('/tmp/repos/acme/widgets.git', 'a/b', 'abc123')).toThrow(
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
      vi.mocked(execFileSync)
        .mockReturnValueOnce('') // gh auth status
        .mockReturnValueOnce('') // gh repo clone
        .mockReturnValueOnce('') // git fetch
        .mockReturnValueOnce('abc123\n') // rev-parse FETCH_HEAD
        .mockReturnValueOnce('') // git worktree add
        .mockReturnValueOnce(''); // git checkout

      const result = await checkoutWorktree('acme', 'widgets', 42, '/tmp/repos', 'task-abc');

      // Worktree is keyed by PR number, not taskId
      expect(result.worktreePath).toBe('/tmp/repos/acme/widgets-worktrees/pr-42');
      expect(result.bareRepoPath).toBe('/tmp/repos/acme/widgets.git');
      expect(result.cloned).toBe(true);

      const calls = vi.mocked(execFileSync).mock.calls;
      // 1: gh auth status (isGhAvailable — hoisted)
      // 2: gh repo clone --bare (ensureBareClone)
      // 3: git fetch (fetchPRRef)
      // 4: git rev-parse --verify FETCH_HEAD (resolve stable commit ID)
      // 5: git worktree add (addWorktree)
      // 6: git checkout --detach --force <sha> (reset reused worktrees to fresh PR tip)
      expect(calls.length).toBe(6);

      // Verify bare clone
      expect(calls[1][1]).toContain('--bare');

      // Verify fetch
      expect(calls[2][1]).toContain('pull/42/head');

      // Verify FETCH_HEAD is resolved in the bare repo, not the linked worktree
      expect(calls[3][1]).toEqual(['rev-parse', '--verify', 'FETCH_HEAD']);
      expect(calls[3][2]).toMatchObject({ cwd: '/tmp/repos/acme/widgets.git' });

      // Verify worktree add uses pr-42 and the resolved commit SHA
      expect(calls[4][1]).toEqual([
        'worktree',
        'add',
        '--detach',
        '/tmp/repos/acme/widgets-worktrees/pr-42',
        'abc123',
      ]);

      // Verify post-add reset uses the resolved commit SHA, not FETCH_HEAD
      expect(calls[5][1]).toEqual(['checkout', '--detach', '--force', 'abc123']);
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
      expect(result.sparse).toBe(false);
      expect(getWorktreeRefCount(result.worktreePath)).toBe(1);
    });

    it('uses sparse checkout when sparseOptions provided', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = await checkoutWorktree('acme', 'widgets', 42, '/tmp/repos', 'task-1', {
        diffPaths: ['src/index.ts', 'src/utils.ts'],
      });

      expect(result.sparse).toBe(true);
      expect(result.worktreePath).toBe('/tmp/repos/acme/widgets-worktrees/pr-42');

      // Should have called sparse-checkout on the WORKTREE path, not bare repo
      const calls = vi.mocked(execFileSync).mock.calls;
      const sparseCheckoutCalls = calls.filter(
        (c) => Array.isArray(c[1]) && (c[1] as string[]).includes('sparse-checkout'),
      );
      expect(sparseCheckoutCalls.length).toBe(1);
      // Verify it targets the worktree, not the bare repo
      expect(sparseCheckoutCalls[0][2]).toMatchObject({
        cwd: '/tmp/repos/acme/widgets-worktrees/pr-42',
      });
    });

    it('uses full clone when sparseOptions has empty diffPaths', async () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(execFileSync).mockReturnValue('');

      const result = await checkoutWorktree('acme', 'widgets', 42, '/tmp/repos', 'task-1', {
        diffPaths: [],
      });

      expect(result.sparse).toBe(false);
    });
  });

  describe('getRepoSize', () => {
    it('returns size from gh api response', () => {
      vi.mocked(execFileSync).mockReturnValue('102400\n');

      const size = getRepoSize('acme', 'widgets');

      expect(size).toBe(102400);
      const call = vi.mocked(execFileSync).mock.calls[0];
      expect(call[0]).toBe('gh');
      expect(call[1]).toEqual(['api', 'repos/acme/widgets', '--jq', '.size']);
    });

    it('returns null when gh api fails', () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('gh not found');
      });

      const size = getRepoSize('acme', 'widgets');

      expect(size).toBeNull();
    });

    it('returns null for non-numeric output', () => {
      vi.mocked(execFileSync).mockReturnValue('not a number\n');

      const size = getRepoSize('acme', 'widgets');

      expect(size).toBeNull();
    });
  });

  describe('parseDiffPaths', () => {
    it('extracts file paths from unified diff', () => {
      const diff = [
        'diff --git a/src/index.ts b/src/index.ts',
        '--- a/src/index.ts',
        '+++ b/src/index.ts',
        '@@ -1,3 +1,4 @@',
        '+import { foo } from "./foo";',
        'diff --git a/src/utils.ts b/src/utils.ts',
        '--- a/src/utils.ts',
        '+++ b/src/utils.ts',
        '@@ -10,2 +10,3 @@',
        '+export const bar = 1;',
      ].join('\n');

      const paths = parseDiffPaths(diff);

      expect(paths).toEqual(['src/index.ts', 'src/utils.ts']);
    });

    it('handles new file (--- /dev/null)', () => {
      const diff = [
        'diff --git a/new-file.ts b/new-file.ts',
        '--- /dev/null',
        '+++ b/new-file.ts',
        '@@ -0,0 +1,5 @@',
        '+export const x = 1;',
      ].join('\n');

      const paths = parseDiffPaths(diff);

      expect(paths).toEqual(['new-file.ts']);
    });

    it('handles deleted file (+++ /dev/null)', () => {
      const diff = [
        'diff --git a/old-file.ts b/old-file.ts',
        '--- a/old-file.ts',
        '+++ /dev/null',
        '@@ -1,5 +0,0 @@',
        '-export const x = 1;',
      ].join('\n');

      const paths = parseDiffPaths(diff);

      expect(paths).toEqual(['old-file.ts']);
    });

    it('deduplicates paths', () => {
      const diff = ['--- a/src/index.ts', '+++ b/src/index.ts'].join('\n');

      const paths = parseDiffPaths(diff);

      expect(paths).toEqual(['src/index.ts']);
    });

    it('returns empty array for empty diff', () => {
      expect(parseDiffPaths('')).toEqual([]);
    });

    it('returns empty array for diff with no file headers', () => {
      expect(parseDiffPaths('some random text\nanother line')).toEqual([]);
    });

    it('handles \\r\\n line endings', () => {
      const diff = '--- a/src/index.ts\r\n+++ b/src/index.ts\r\n@@ -1,3 +1,4 @@\r\n';

      const paths = parseDiffPaths(diff);

      expect(paths).toEqual(['src/index.ts']);
    });
  });

  describe('buildSparsePatterns', () => {
    it('includes diff files and root configs', () => {
      const patterns = buildSparsePatterns(['src/index.ts', 'src/utils.ts']);

      expect(patterns).toContain('src/index.ts');
      expect(patterns).toContain('src/utils.ts');
      expect(patterns).toContain('package.json');
      expect(patterns).toContain('tsconfig.json');
    });

    it('deduplicates patterns', () => {
      const patterns = buildSparsePatterns(['package.json', 'src/index.ts']);

      const packageJsonCount = patterns.filter((p) => p === 'package.json').length;
      expect(packageJsonCount).toBe(1);
    });

    it('includes standard root config files', () => {
      const patterns = buildSparsePatterns([]);

      expect(patterns).toContain('package.json');
      expect(patterns).toContain('tsconfig.json');
      expect(patterns).toContain('Cargo.toml');
      expect(patterns).toContain('go.mod');
      expect(patterns).toContain('pyproject.toml');
    });
  });

  describe('configureSparseCheckout', () => {
    it('calls git sparse-checkout set with -- separator and correct patterns', () => {
      vi.mocked(execFileSync).mockReturnValue('');

      configureSparseCheckout('/tmp/worktrees/pr-42', ['src/index.ts']);

      const call = vi.mocked(execFileSync).mock.calls[0];
      expect(call[0]).toBe('git');
      const args = call[1] as string[];
      expect(args[0]).toBe('sparse-checkout');
      expect(args[1]).toBe('set');
      expect(args[2]).toBe('--no-cone');
      expect(args[3]).toBe('--');
      expect(args).toContain('src/index.ts');
      expect(args).toContain('package.json');
      expect(call[2]).toMatchObject({ cwd: '/tmp/worktrees/pr-42' });
    });
  });

  describe('deriveDefaultBranch', () => {
    it('returns the branch parsed from symbolic-ref AND refreshes it via fetch', () => {
      // symbolic-ref gives us the branch name, but the bare clone is cached
      // across runs so we MUST fetch to refresh `refs/remotes/origin/<branch>`
      // before the caller diffs against it.
      vi.mocked(execFileSync)
        .mockReturnValueOnce('refs/remotes/origin/main\n') // symbolic-ref
        .mockReturnValueOnce(''); // fetch main

      const branch = deriveDefaultBranch('/tmp/repos/acme/widgets.git', true);

      expect(branch).toBe('main');
      const calls = vi.mocked(execFileSync).mock.calls;
      expect(calls).toHaveLength(2);
      expect(calls[0][1]).toEqual(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      const fetchArgs = calls[1][1] as string[];
      expect(fetchArgs).toContain('fetch');
      expect(fetchArgs).toContain('main:refs/remotes/origin/main');
      expect(fetchArgs).toContain('credential.helper=!gh auth git-credential');
    });

    it('handles branches with slashes in their names and fetches them', () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce('refs/remotes/origin/release/2026.04\n')
        .mockReturnValueOnce(''); // fetch release/2026.04

      const branch = deriveDefaultBranch('/tmp/repos/acme/widgets.git', true);

      expect(branch).toBe('release/2026.04');
      const fetchArgs = vi.mocked(execFileSync).mock.calls[1][1] as string[];
      expect(fetchArgs).toContain('release/2026.04:refs/remotes/origin/release/2026.04');
    });

    it('falls through to candidate probes when the symbolic-ref fetch fails', () => {
      // If the symbolic-ref refresh fetch fails (e.g., branch deleted since
      // HEAD was set at clone time), we continue to the candidate list so a
      // working base is still resolved.
      vi.mocked(execFileSync)
        .mockReturnValueOnce('refs/remotes/origin/gone\n') // symbolic-ref
        .mockImplementationOnce(() => {
          throw new Error("fatal: couldn't find remote ref gone");
        }) // fetch gone — fails
        .mockReturnValueOnce(''); // fetch main succeeds

      const branch = deriveDefaultBranch('/tmp/repos/acme/widgets.git', true);

      expect(branch).toBe('main');
    });

    it('falls back to main when symbolic-ref fails', () => {
      vi.mocked(execFileSync)
        .mockImplementationOnce(() => {
          throw new Error('symbolic-ref: no such ref');
        })
        .mockReturnValueOnce(''); // main fetch succeeds

      const branch = deriveDefaultBranch('/tmp/repos/acme/widgets.git', true);

      expect(branch).toBe('main');
      const calls = vi.mocked(execFileSync).mock.calls;
      expect(calls).toHaveLength(2);
      const fetchArgs = calls[1][1] as string[];
      expect(fetchArgs).toContain('fetch');
      expect(fetchArgs).toContain('main:refs/remotes/origin/main');
      expect(fetchArgs).toContain('credential.helper=!gh auth git-credential');
    });

    it('falls back to master when symbolic-ref and main both fail', () => {
      vi.mocked(execFileSync)
        .mockImplementationOnce(() => {
          throw new Error('symbolic-ref failed');
        })
        .mockImplementationOnce(() => {
          throw new Error('main not found');
        })
        .mockReturnValueOnce(''); // master fetch succeeds

      const branch = deriveDefaultBranch('/tmp/repos/acme/widgets.git', false);

      expect(branch).toBe('master');
      const calls = vi.mocked(execFileSync).mock.calls;
      expect(calls).toHaveLength(3);
      const masterFetchArgs = calls[2][1] as string[];
      expect(masterFetchArgs).toContain('master:refs/remotes/origin/master');
      expect(masterFetchArgs).not.toContain('-c');
    });

    it('throws when symbolic-ref and all fallbacks fail', () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('failed');
      });

      expect(() => deriveDefaultBranch('/tmp/repos/acme/widgets.git', true)).toThrow(
        /Cannot derive default branch/,
      );
    });

    it('rejects a symbolic-ref output with an unexpected prefix and falls back', () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce('refs/heads/main\n') // unexpected prefix — skipped
        .mockReturnValueOnce(''); // main fetch succeeds

      const branch = deriveDefaultBranch('/tmp/repos/acme/widgets.git', true);

      expect(branch).toBe('main');
    });

    it('rejects a branch name that fails the allowlist and falls back', () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce('refs/remotes/origin/-malicious\n') // rejected: leading dash
        .mockReturnValueOnce(''); // main fetch succeeds

      const branch = deriveDefaultBranch('/tmp/repos/acme/widgets.git', true);

      expect(branch).toBe('main');
    });

    it('rejects a branch name containing `..` and falls back', () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce('refs/remotes/origin/re..lease\n') // rejected: contains ..
        .mockReturnValueOnce(''); // main fetch succeeds

      const branch = deriveDefaultBranch('/tmp/repos/acme/widgets.git', true);

      expect(branch).toBe('main');
    });
  });

  describe('diffFromWorktree', () => {
    it('fetches the supplied base_ref and runs git diff ...HEAD', () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce('') // fetch main
        .mockReturnValueOnce('diff --git a/a b/a\n'); // git diff

      const diff = diffFromWorktree(
        '/tmp/repos/acme/widgets.git',
        '/tmp/repos/acme/widgets-worktrees/pr-42',
        'main',
        true,
      );

      expect(diff).toContain('diff --git');
      const calls = vi.mocked(execFileSync).mock.calls;
      expect(calls).toHaveLength(2);

      // Fetch call runs in the bare repo with credential helper
      const fetchArgs = calls[0][1] as string[];
      expect(fetchArgs).toContain('fetch');
      expect(fetchArgs).toContain('main:refs/remotes/origin/main');
      expect(calls[0][2]).toMatchObject({ cwd: '/tmp/repos/acme/widgets.git' });

      // Diff call runs in the worktree
      expect(calls[1][1]).toEqual(['diff', 'origin/main...HEAD']);
      expect(calls[1][2]).toMatchObject({ cwd: '/tmp/repos/acme/widgets-worktrees/pr-42' });
    });

    it('rejects an invalid base_ref without shelling out', () => {
      expect(() =>
        diffFromWorktree(
          '/tmp/repos/acme/widgets.git',
          '/tmp/repos/acme/widgets-worktrees/pr-42',
          '-malicious',
          true,
        ),
      ).toThrow(/Invalid base ref/);
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    });

    it('derives the default branch when base_ref is undefined', () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce('refs/remotes/origin/main\n') // symbolic-ref
        .mockReturnValueOnce('') // fetch main (refresh stale cache)
        .mockReturnValueOnce('diff --git a/a b/a\n'); // git diff

      const diff = diffFromWorktree(
        '/tmp/repos/acme/widgets.git',
        '/tmp/repos/acme/widgets-worktrees/pr-42',
        undefined,
        true,
      );

      expect(diff).toContain('diff --git');
      const calls = vi.mocked(execFileSync).mock.calls;
      expect(calls).toHaveLength(3);
      expect(calls[0][1]).toEqual(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      const fetchArgs = calls[1][1] as string[];
      expect(fetchArgs).toContain('main:refs/remotes/origin/main');
      expect(calls[2][1]).toEqual(['diff', 'origin/main...HEAD']);
    });

    it('derives via main fallback when base_ref is empty string', () => {
      vi.mocked(execFileSync)
        .mockImplementationOnce(() => {
          throw new Error('symbolic-ref fails');
        })
        .mockReturnValueOnce('') // main fetch succeeds
        .mockReturnValueOnce('diff --git a/a b/a\n'); // git diff against main

      const diff = diffFromWorktree(
        '/tmp/repos/acme/widgets.git',
        '/tmp/repos/acme/widgets-worktrees/pr-42',
        '',
        true,
      );

      expect(diff).toContain('diff --git');
      const diffCall = vi.mocked(execFileSync).mock.calls.at(-1);
      expect(diffCall?.[1]).toEqual(['diff', 'origin/main...HEAD']);
    });

    it('derives via master fallback when symbolic-ref and main both fail', () => {
      vi.mocked(execFileSync)
        .mockImplementationOnce(() => {
          throw new Error('symbolic-ref fails');
        })
        .mockImplementationOnce(() => {
          throw new Error('main not found');
        })
        .mockReturnValueOnce('') // master fetch succeeds
        .mockReturnValueOnce('diff --git a/a b/a\n'); // git diff against master

      const diff = diffFromWorktree(
        '/tmp/repos/acme/widgets.git',
        '/tmp/repos/acme/widgets-worktrees/pr-42',
        null,
        true,
      );

      expect(diff).toContain('diff --git');
      const diffCall = vi.mocked(execFileSync).mock.calls.at(-1);
      expect(diffCall?.[1]).toEqual(['diff', 'origin/master...HEAD']);
    });

    it('propagates derive-base failure to the caller', () => {
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('all refs fail');
      });

      expect(() =>
        diffFromWorktree(
          '/tmp/repos/acme/widgets.git',
          '/tmp/repos/acme/widgets-worktrees/pr-42',
          undefined,
          true,
        ),
      ).toThrow(/Cannot derive default branch/);
    });

    it('translates maxBuffer errors into DiffTooLargeError', () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce('') // fetch main
        .mockImplementationOnce(() => {
          throw new Error('stdout maxBuffer length exceeded');
        });

      expect(() =>
        diffFromWorktree(
          '/tmp/repos/acme/widgets.git',
          '/tmp/repos/acme/widgets-worktrees/pr-42',
          'main',
          true,
          1024,
        ),
      ).toThrow(DiffTooLargeError);
    });

    it('rethrows non-maxBuffer git-diff errors unchanged', () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce('') // fetch main
        .mockImplementationOnce(() => {
          throw new Error('fatal: ambiguous argument');
        });

      expect(() =>
        diffFromWorktree(
          '/tmp/repos/acme/widgets.git',
          '/tmp/repos/acme/widgets-worktrees/pr-42',
          'main',
          true,
        ),
      ).toThrow(/fatal: ambiguous argument/);
    });

    it('omits credential helper when gh is not available', () => {
      vi.mocked(execFileSync)
        .mockReturnValueOnce('') // fetch main
        .mockReturnValueOnce(''); // git diff

      diffFromWorktree(
        '/tmp/repos/acme/widgets.git',
        '/tmp/repos/acme/widgets-worktrees/pr-42',
        'main',
        false,
      );

      const fetchArgs = vi.mocked(execFileSync).mock.calls[0][1] as string[];
      expect(fetchArgs).not.toContain('-c');
    });

    it('falls back to derive-base when the provided base_ref no longer exists on origin', () => {
      // Simulates a stale base_ref after a force-push or branch rename: the
      // targeted fetch surfaces "couldn't find remote ref", which is the
      // signal that the branch is genuinely gone. In that (and only that)
      // case we derive the default branch and diff against it.
      vi.mocked(execFileSync)
        .mockImplementationOnce(() => {
          throw new Error(
            "fatal: couldn't find remote ref stale-branch\nerror: some refs could not be fetched",
          );
        }) // fetch base_ref=stale-branch — missing on origin
        .mockReturnValueOnce('refs/remotes/origin/main\n') // symbolic-ref
        .mockReturnValueOnce('') // refresh fetch of main
        .mockReturnValueOnce('diff --git a/a b/a\n'); // git diff against main

      const diff = diffFromWorktree(
        '/tmp/repos/acme/widgets.git',
        '/tmp/repos/acme/widgets-worktrees/pr-42',
        'stale-branch',
        true,
      );

      expect(diff).toContain('diff --git');
      const calls = vi.mocked(execFileSync).mock.calls;
      expect(calls).toHaveLength(4);
      expect(calls[0][1] as string[]).toContain('stale-branch:refs/remotes/origin/stale-branch');
      expect(calls[1][1]).toEqual(['symbolic-ref', 'refs/remotes/origin/HEAD']);
      expect(calls[2][1] as string[]).toContain('main:refs/remotes/origin/main');
      expect(calls[3][1]).toEqual(['diff', 'origin/main...HEAD']);
    });

    it('rethrows transient fetch errors instead of silently diffing against the default branch', () => {
      // Network/auth/timeout errors MUST NOT be treated as "branch missing".
      // If we silently derived the default branch here, a PR against
      // `develop` would get reviewed as if it were against `main` — the
      // review would be about a completely different patch.
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw new Error('fatal: unable to access https://github.com/: Could not resolve host');
      });

      expect(() =>
        diffFromWorktree(
          '/tmp/repos/acme/widgets.git',
          '/tmp/repos/acme/widgets-worktrees/pr-42',
          'develop',
          true,
        ),
      ).toThrow(/Could not resolve host/);

      // Only the initial fetch call ran — no derive-base probes.
      expect(vi.mocked(execFileSync).mock.calls).toHaveLength(1);
    });

    it('also recognizes alternative remote-ref-missing error phrasings', () => {
      // Git wording varies; `no such ref` is another common form.
      vi.mocked(execFileSync)
        .mockImplementationOnce(() => {
          throw new Error('fatal: no such ref: refs/heads/gone');
        })
        .mockReturnValueOnce('refs/remotes/origin/main\n')
        .mockReturnValueOnce('') // refresh fetch
        .mockReturnValueOnce('diff --git a/a b/a\n');

      const diff = diffFromWorktree(
        '/tmp/repos/acme/widgets.git',
        '/tmp/repos/acme/widgets-worktrees/pr-42',
        'gone',
        true,
      );

      expect(diff).toContain('diff --git');
    });

    it('propagates derive-base failure when both the stale base_ref and derivation fail', () => {
      // If the targeted fetch fails with "remote ref missing" AND derive-base
      // also fails, the caller sees the derive-base error so agent.ts rejects
      // the task loudly.
      vi.mocked(execFileSync).mockImplementationOnce(() => {
        throw new Error("fatal: couldn't find remote ref stale-branch");
      });
      vi.mocked(execFileSync).mockImplementation(() => {
        throw new Error('every git call fails');
      });

      expect(() =>
        diffFromWorktree(
          '/tmp/repos/acme/widgets.git',
          '/tmp/repos/acme/widgets-worktrees/pr-42',
          'stale-branch',
          true,
        ),
      ).toThrow(/Cannot derive default branch/);
    });

    it('rejects a base_ref containing `..` without shelling out', () => {
      expect(() =>
        diffFromWorktree(
          '/tmp/repos/acme/widgets.git',
          '/tmp/repos/acme/widgets-worktrees/pr-42',
          're..lease',
          true,
        ),
      ).toThrow(/Invalid base ref/);
      expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
    });
  });
});
