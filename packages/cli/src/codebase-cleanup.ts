import * as fs from 'node:fs';
import * as path from 'node:path';

/** Default TTL for codebase directories: 30 minutes. */
export const DEFAULT_CODEBASE_TTL_MS = 30 * 60 * 1000;

/**
 * Parse a TTL duration string into milliseconds.
 * Supports: "0" (immediate), "30m", "2h", "24h", "1d", plain seconds as number-string.
 */
export function parseTtl(value: string): number {
  const trimmed = value.trim();
  if (trimmed === '0') return 0;

  const match = trimmed.match(/^(\d+)\s*(ms|s|m|h|d)$/);
  if (match) {
    const num = parseInt(match[1], 10);
    switch (match[2]) {
      case 'ms':
        return num;
      case 's':
        return num * 1000;
      case 'm':
        return num * 60 * 1000;
      case 'h':
        return num * 60 * 60 * 1000;
      case 'd':
        return num * 24 * 60 * 60 * 1000;
      default:
        throw new Error(`Unreachable: unhandled unit "${match[2]}"`);
    }
  }

  // Plain number = seconds (must be all digits)
  if (/^\d+$/.test(trimmed)) {
    return parseInt(trimmed, 10) * 1000;
  }

  throw new Error(`Invalid codebase_ttl: "${value}". Use "0", "30m", "2h", "24h", "1d", etc.`);
}

/** Entry tracking a completed task's worktree dir for deferred cleanup. */
interface PendingCleanup {
  /** Absolute path to the bare repo */
  bareRepoPath: string;
  /** Absolute path to the worktree directory */
  worktreePath: string;
  /** Timestamp when the task completed */
  completedAt: number;
}

/**
 * Tracks completed task directories and cleans them up after the configured TTL.
 *
 * When TTL is 0, cleanup happens immediately (caller should not use the tracker).
 * When TTL > 0, directories are kept for inspection and cleaned on schedule.
 */
export class CodebaseCleanupTracker {
  private pending: PendingCleanup[] = [];
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /**
   * Record a completed task's worktree for deferred cleanup.
   */
  track(bareRepoPath: string, worktreePath: string): void {
    this.pending.push({
      bareRepoPath,
      worktreePath,
      completedAt: Date.now(),
    });
  }

  /**
   * Check for and remove any worktrees that have exceeded the TTL.
   * Returns the number of directories cleaned up.
   *
   * The removeFn callback performs the actual git worktree removal.
   */
  async sweep(
    removeFn: (bareRepoPath: string, worktreePath: string) => Promise<void>,
  ): Promise<number> {
    const now = Date.now();
    const expired: PendingCleanup[] = [];
    const remaining: PendingCleanup[] = [];

    for (const entry of this.pending) {
      if (now - entry.completedAt >= this.ttlMs) {
        expired.push(entry);
      } else {
        remaining.push(entry);
      }
    }

    this.pending = remaining;

    let cleaned = 0;
    for (const entry of expired) {
      try {
        await removeFn(entry.bareRepoPath, entry.worktreePath);
        cleaned++;
      } catch {
        // Re-queue for next sweep — removeFn already logs the error
        this.pending.push(entry);
      }
    }

    return cleaned;
  }

  /** Number of entries pending cleanup. */
  get size(): number {
    return this.pending.length;
  }
}

/**
 * Scan the codebase directory for stale worktree directories (from crashes/timeouts)
 * and remove any older than the given TTL.
 *
 * Directory structure expected:
 *   <baseDir>/<owner>/<repo>-worktrees/<pr-N>/
 *   <baseDir>/<owner>/<repo>.git/  (bare repos — never removed)
 *
 * Returns the number of stale directories removed.
 */
export function scanAndCleanStaleWorktrees(baseDir: string, ttlMs: number): number {
  if (!fs.existsSync(baseDir)) return 0;

  const now = Date.now();
  let cleaned = 0;

  // Iterate <owner> directories
  let ownerDirs: string[];
  try {
    ownerDirs = fs.readdirSync(baseDir);
  } catch {
    return 0;
  }

  for (const ownerName of ownerDirs) {
    const ownerPath = path.join(baseDir, ownerName);
    let stat: fs.Stats;
    try {
      stat = fs.statSync(ownerPath);
    } catch {
      continue;
    }
    if (!stat.isDirectory()) continue;

    // Find <repo>-worktrees directories
    let entries: string[];
    try {
      entries = fs.readdirSync(ownerPath);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.endsWith('-worktrees')) continue;

      const worktreeBasePath = path.join(ownerPath, entry);
      let worktreeStat: fs.Stats;
      try {
        worktreeStat = fs.statSync(worktreeBasePath);
      } catch {
        continue;
      }
      if (!worktreeStat.isDirectory()) continue;

      // Scan individual task worktree directories
      let taskDirs: string[];
      try {
        taskDirs = fs.readdirSync(worktreeBasePath);
      } catch {
        continue;
      }

      for (const taskId of taskDirs) {
        const taskPath = path.join(worktreeBasePath, taskId);
        let taskStat: fs.Stats;
        try {
          taskStat = fs.statSync(taskPath);
        } catch {
          continue;
        }
        if (!taskStat.isDirectory()) continue;

        // Use the most recent modification time as the "last active" timestamp
        const age = now - taskStat.mtimeMs;
        if (age >= ttlMs) {
          try {
            fs.rmSync(taskPath, { recursive: true, force: true });

            // Also clean git worktree metadata in the bare repo to prevent ghost entries.
            // Worktree dir: <owner>/<repo>-worktrees/<taskId>
            // Bare repo:    <owner>/<repo>.git/worktrees/<taskId>
            const repoName = entry.replace(/-worktrees$/, '');
            const metadataPath = path.join(ownerPath, `${repoName}.git`, 'worktrees', taskId);
            try {
              fs.rmSync(metadataPath, { recursive: true, force: true });
            } catch {
              // Best-effort — metadata may not exist
            }

            cleaned++;
          } catch {
            // Best-effort cleanup
          }
        }
      }
    }
  }

  return cleaned;
}
