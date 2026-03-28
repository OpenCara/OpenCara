import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: vi.fn(),
    readdirSync: vi.fn(),
    statSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

import * as fs from 'node:fs';
import {
  parseTtl,
  CodebaseCleanupTracker,
  scanAndCleanStaleWorktrees,
  DEFAULT_CODEBASE_TTL_MS,
} from '../codebase-cleanup.js';

describe('codebase-cleanup', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('parseTtl', () => {
    it('parses "0" as immediate (0 ms)', () => {
      expect(parseTtl('0')).toBe(0);
    });

    it('parses milliseconds', () => {
      expect(parseTtl('500ms')).toBe(500);
    });

    it('parses seconds', () => {
      expect(parseTtl('30s')).toBe(30_000);
    });

    it('parses minutes', () => {
      expect(parseTtl('30m')).toBe(30 * 60 * 1000);
    });

    it('parses hours', () => {
      expect(parseTtl('24h')).toBe(24 * 60 * 60 * 1000);
    });

    it('parses days', () => {
      expect(parseTtl('1d')).toBe(24 * 60 * 60 * 1000);
    });

    it('parses plain number as seconds', () => {
      expect(parseTtl('60')).toBe(60_000);
    });

    it('trims whitespace', () => {
      expect(parseTtl('  30m  ')).toBe(30 * 60 * 1000);
    });

    it('throws on invalid format', () => {
      expect(() => parseTtl('abc')).toThrow('Invalid codebase_ttl');
    });

    it('throws on negative numbers', () => {
      expect(() => parseTtl('-1')).toThrow('Invalid codebase_ttl');
    });

    it('throws on unknown unit', () => {
      expect(() => parseTtl('30x')).toThrow('Invalid codebase_ttl');
    });
  });

  describe('DEFAULT_CODEBASE_TTL_MS', () => {
    it('defaults to 30 minutes', () => {
      expect(DEFAULT_CODEBASE_TTL_MS).toBe(30 * 60 * 1000);
    });
  });

  describe('CodebaseCleanupTracker', () => {
    it('tracks entries and reports size', () => {
      const tracker = new CodebaseCleanupTracker(60_000);
      expect(tracker.size).toBe(0);

      tracker.track('/bare/repo.git', '/worktree/task-1');
      expect(tracker.size).toBe(1);

      tracker.track('/bare/repo.git', '/worktree/task-2');
      expect(tracker.size).toBe(2);
    });

    it('sweeps expired entries', async () => {
      const tracker = new CodebaseCleanupTracker(0); // TTL = 0 → everything is expired
      tracker.track('/bare/repo.git', '/worktree/task-1');
      tracker.track('/bare/repo.git', '/worktree/task-2');

      const removeFn = vi.fn().mockResolvedValue(undefined);
      const cleaned = await tracker.sweep(removeFn);

      expect(cleaned).toBe(2);
      expect(removeFn).toHaveBeenCalledTimes(2);
      expect(removeFn).toHaveBeenCalledWith('/bare/repo.git', '/worktree/task-1');
      expect(removeFn).toHaveBeenCalledWith('/bare/repo.git', '/worktree/task-2');
      expect(tracker.size).toBe(0);
    });

    it('does not sweep entries within TTL', async () => {
      const tracker = new CodebaseCleanupTracker(60_000); // 1 minute TTL
      tracker.track('/bare/repo.git', '/worktree/task-1');

      const removeFn = vi.fn().mockResolvedValue(undefined);
      const cleaned = await tracker.sweep(removeFn);

      expect(cleaned).toBe(0);
      expect(removeFn).not.toHaveBeenCalled();
      expect(tracker.size).toBe(1);
    });

    it('handles remove function errors gracefully', async () => {
      const tracker = new CodebaseCleanupTracker(0);
      tracker.track('/bare/repo.git', '/worktree/task-1');
      tracker.track('/bare/repo.git', '/worktree/task-2');

      const removeFn = vi
        .fn()
        .mockRejectedValueOnce(new Error('rm failed'))
        .mockResolvedValueOnce(undefined);

      const cleaned = await tracker.sweep(removeFn);

      // Only the second one succeeded
      expect(cleaned).toBe(1);
      expect(removeFn).toHaveBeenCalledTimes(2);
      expect(tracker.size).toBe(0); // Both removed from pending
    });

    it('sweeps only expired entries, keeps fresh ones', async () => {
      const tracker = new CodebaseCleanupTracker(100); // 100ms TTL

      // Track an entry, then wait for it to expire
      tracker.track('/bare/repo.git', '/worktree/old-task');

      // Wait for the entry to expire
      await new Promise((r) => setTimeout(r, 150));

      // Track a fresh entry
      tracker.track('/bare/repo.git', '/worktree/new-task');

      const removeFn = vi.fn().mockResolvedValue(undefined);
      const cleaned = await tracker.sweep(removeFn);

      expect(cleaned).toBe(1);
      expect(removeFn).toHaveBeenCalledWith('/bare/repo.git', '/worktree/old-task');
      expect(tracker.size).toBe(1); // new-task still pending
    });
  });

  describe('scanAndCleanStaleWorktrees', () => {
    it('returns 0 when baseDir does not exist', () => {
      vi.mocked(fs.existsSync).mockReturnValue(false);
      expect(scanAndCleanStaleWorktrees('/tmp/repos', 60_000)).toBe(0);
    });

    it('cleans stale worktree directories', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockImplementation(((dirPath: string) => {
        if (dirPath === '/tmp/repos') return ['acme'];
        if (dirPath === '/tmp/repos/acme') return ['widgets.git', 'widgets-worktrees'];
        if (dirPath === '/tmp/repos/acme/widgets-worktrees') return ['task-old', 'task-new'];
        return [];
      }) as typeof fs.readdirSync);

      const now = Date.now();
      vi.mocked(fs.statSync).mockImplementation(((statPath: string) => {
        if (statPath === '/tmp/repos/acme') return { isDirectory: () => true } as fs.Stats;
        if (statPath === '/tmp/repos/acme/widgets-worktrees')
          return { isDirectory: () => true } as fs.Stats;
        if (statPath === '/tmp/repos/acme/widgets-worktrees/task-old')
          return { isDirectory: () => true, mtimeMs: now - 120_000 } as fs.Stats; // 2 min old
        if (statPath === '/tmp/repos/acme/widgets-worktrees/task-new')
          return { isDirectory: () => true, mtimeMs: now - 10_000 } as fs.Stats; // 10s old
        return { isDirectory: () => false } as fs.Stats;
      }) as typeof fs.statSync);

      const cleaned = scanAndCleanStaleWorktrees('/tmp/repos', 60_000); // 1 min TTL

      expect(cleaned).toBe(1);
      expect(fs.rmSync).toHaveBeenCalledWith('/tmp/repos/acme/widgets-worktrees/task-old', {
        recursive: true,
        force: true,
      });
      expect(fs.rmSync).not.toHaveBeenCalledWith(
        '/tmp/repos/acme/widgets-worktrees/task-new',
        expect.anything(),
      );
    });

    it('skips non-worktree directories (bare repos)', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockImplementation(((dirPath: string) => {
        if (dirPath === '/tmp/repos') return ['acme'];
        if (dirPath === '/tmp/repos/acme') return ['widgets.git'];
        return [];
      }) as typeof fs.readdirSync);

      vi.mocked(fs.statSync).mockImplementation(() => ({ isDirectory: () => true }) as fs.Stats);

      const cleaned = scanAndCleanStaleWorktrees('/tmp/repos', 60_000);
      expect(cleaned).toBe(0);
      expect(fs.rmSync).not.toHaveBeenCalled();
    });

    it('handles readdir errors gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockImplementation(() => {
        throw new Error('EACCES');
      });

      expect(scanAndCleanStaleWorktrees('/tmp/repos', 60_000)).toBe(0);
    });

    it('handles stat errors gracefully', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readdirSync).mockImplementation(((dirPath: string) => {
        if (dirPath === '/tmp/repos') return ['acme'];
        return [];
      }) as typeof fs.readdirSync);

      vi.mocked(fs.statSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });

      expect(scanAndCleanStaleWorktrees('/tmp/repos', 60_000)).toBe(0);
    });

    it('handles rmSync errors gracefully and continues', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const now = Date.now();

      vi.mocked(fs.readdirSync).mockImplementation(((dirPath: string) => {
        if (dirPath === '/tmp/repos') return ['acme'];
        if (dirPath === '/tmp/repos/acme') return ['widgets-worktrees'];
        if (dirPath === '/tmp/repos/acme/widgets-worktrees') return ['task-1', 'task-2'];
        return [];
      }) as typeof fs.readdirSync);

      vi.mocked(fs.statSync).mockImplementation(((statPath: string) => {
        if (statPath === '/tmp/repos/acme') return { isDirectory: () => true } as fs.Stats;
        if (statPath === '/tmp/repos/acme/widgets-worktrees')
          return { isDirectory: () => true } as fs.Stats;
        return { isDirectory: () => true, mtimeMs: now - 120_000 } as fs.Stats;
      }) as typeof fs.statSync);

      vi.mocked(fs.rmSync)
        .mockImplementationOnce(() => {
          throw new Error('EBUSY');
        })
        .mockImplementationOnce(() => {}); // second succeeds

      const cleaned = scanAndCleanStaleWorktrees('/tmp/repos', 60_000);
      expect(cleaned).toBe(1); // only the second one counted
      expect(fs.rmSync).toHaveBeenCalledTimes(2);
    });

    it('skips non-directory entries in worktree base', () => {
      vi.mocked(fs.existsSync).mockReturnValue(true);
      const now = Date.now();

      vi.mocked(fs.readdirSync).mockImplementation(((dirPath: string) => {
        if (dirPath === '/tmp/repos') return ['acme'];
        if (dirPath === '/tmp/repos/acme') return ['widgets-worktrees'];
        if (dirPath === '/tmp/repos/acme/widgets-worktrees') return ['a-file'];
        return [];
      }) as typeof fs.readdirSync);

      vi.mocked(fs.statSync).mockImplementation(((statPath: string) => {
        if (statPath === '/tmp/repos/acme') return { isDirectory: () => true } as fs.Stats;
        if (statPath === '/tmp/repos/acme/widgets-worktrees')
          return { isDirectory: () => true } as fs.Stats;
        // The file entry is not a directory
        return { isDirectory: () => false, mtimeMs: now - 120_000 } as fs.Stats;
      }) as typeof fs.statSync);

      const cleaned = scanAndCleanStaleWorktrees('/tmp/repos', 60_000);
      expect(cleaned).toBe(0);
      expect(fs.rmSync).not.toHaveBeenCalled();
    });
  });
});
