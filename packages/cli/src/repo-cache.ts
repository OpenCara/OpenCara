import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sanitizeTokens } from './sanitize.js';
import { validatePathSegment, isGhAvailable, buildCloneUrl } from './codebase.js';

/** Git credential helper arg that delegates to gh CLI */
const GH_CREDENTIAL_HELPER = '!gh auth git-credential';

/** Default timeout for git operations (2 minutes). */
const GIT_TIMEOUT_MS = 120_000;

/**
 * Per-repo mutex to serialize git fetch operations.
 * Multiple concurrent tasks on the same repo must not fetch simultaneously
 * (git lock file conflicts).
 */
const repoLocks = new Map<string, Promise<void>>();

export interface WorktreeCheckoutResult {
  /** Absolute path to the worktree directory */
  worktreePath: string;
  /** Absolute path to the bare repo */
  bareRepoPath: string;
  /** Whether the bare repo was freshly cloned */
  cloned: boolean;
}

/**
 * Acquire a per-repo lock, execute fn, then release.
 * Concurrent callers on the same repoKey queue behind the current holder.
 */
export async function withRepoLock<T>(repoKey: string, fn: () => T | Promise<T>): Promise<T> {
  // Wait for any in-flight operation on this repo
  const existing = repoLocks.get(repoKey);
  let release: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  repoLocks.set(repoKey, existing ? existing.then(() => gate) : gate);

  try {
    if (existing) await existing;
    return await fn();
  } finally {
    release!();
    // Clean up if we're still the latest holder
    if (repoLocks.get(repoKey) === gate) {
      repoLocks.delete(repoKey);
    }
  }
}

/**
 * Ensure a persistent bare clone exists for the given repo.
 * Path: `<baseDir>/<owner>/<repo>.git/`
 *
 * Uses `--bare --filter=blob:none` for minimal disk usage.
 * Returns the bare repo path and whether it was freshly created.
 */
export function ensureBareClone(
  owner: string,
  repo: string,
  baseDir: string,
): { bareRepoPath: string; cloned: boolean } {
  validatePathSegment(owner, 'owner');
  validatePathSegment(repo, 'repo');

  const bareRepoPath = path.join(baseDir, owner, `${repo}.git`);

  if (fs.existsSync(path.join(bareRepoPath, 'HEAD'))) {
    return { bareRepoPath, cloned: false };
  }

  // Create parent dir
  fs.mkdirSync(path.join(baseDir, owner), { recursive: true });

  const ghAvailable = isGhAvailable();

  if (ghAvailable) {
    // gh repo clone with --bare
    gitExec('gh', [
      'repo',
      'clone',
      `${owner}/${repo}`,
      bareRepoPath,
      '--',
      '--bare',
      '--filter=blob:none',
    ]);
  } else {
    // Fallback: unauthenticated bare clone
    const cloneUrl = buildCloneUrl(owner, repo);
    gitExec('git', ['clone', '--bare', '--filter=blob:none', cloneUrl, bareRepoPath]);
  }

  return { bareRepoPath, cloned: true };
}

/**
 * Fetch a PR ref into the bare repo.
 * Uses credential helper when gh is available.
 */
export function fetchPRRef(bareRepoPath: string, prNumber: number): void {
  const ghAvailable = isGhAvailable();
  const credArgs = ghAvailable ? ['-c', `credential.helper=${GH_CREDENTIAL_HELPER}`] : [];
  gitExec(
    'git',
    [...credArgs, 'fetch', '--force', 'origin', `pull/${prNumber}/head`],
    bareRepoPath,
  );
}

/**
 * Create a git worktree for a specific task from the bare repo.
 * The worktree is checked out at FETCH_HEAD (the PR ref just fetched).
 *
 * Path: `<bareRepoPath>/../<repo>-worktrees/<taskId>/`
 */
export function addWorktree(bareRepoPath: string, taskId: string): string {
  validatePathSegment(taskId, 'taskId');

  // Place worktrees alongside the bare repo for clean organization
  // e.g., <baseDir>/<owner>/<repo>-worktrees/<taskId>/
  const repoName = path.basename(bareRepoPath, '.git');
  const worktreeBase = path.join(path.dirname(bareRepoPath), `${repoName}-worktrees`);
  const worktreePath = path.join(worktreeBase, taskId);

  fs.mkdirSync(worktreeBase, { recursive: true });

  gitExec('git', ['worktree', 'add', '--detach', worktreePath, 'FETCH_HEAD'], bareRepoPath);

  return worktreePath;
}

/**
 * Remove a git worktree after task completion.
 * Uses `git worktree remove --force` to handle dirty worktrees.
 */
export function removeWorktree(bareRepoPath: string, worktreePath: string): void {
  try {
    gitExec('git', ['worktree', 'remove', '--force', worktreePath], bareRepoPath);
  } catch {
    // Fallback: manually remove the directory if git worktree remove fails
    // (e.g., if the worktree metadata is corrupted)
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      // Prune stale worktree references
      gitExec('git', ['worktree', 'prune'], bareRepoPath);
    } catch {
      // Best-effort cleanup — log and move on
      console.warn(`[repo-cache] Failed to clean up worktree: ${worktreePath}`);
    }
  }
}

/**
 * High-level: checkout a PR into an isolated worktree.
 *
 * 1. Ensure bare clone exists (or reuse cached)
 * 2. Fetch PR ref (with per-repo lock)
 * 3. Create worktree for the task
 *
 * Returns the worktree path for use as cwd during review.
 */
export async function checkoutWorktree(
  owner: string,
  repo: string,
  prNumber: number,
  baseDir: string,
  taskId: string,
): Promise<WorktreeCheckoutResult> {
  validatePathSegment(owner, 'owner');
  validatePathSegment(repo, 'repo');
  validatePathSegment(taskId, 'taskId');

  const repoKey = `${owner}/${repo}`;

  // Serialize fetch operations per repo to avoid git lock conflicts
  return withRepoLock(repoKey, () => {
    const { bareRepoPath, cloned } = ensureBareClone(owner, repo, baseDir);
    fetchPRRef(bareRepoPath, prNumber);
    const worktreePath = addWorktree(bareRepoPath, taskId);
    return { worktreePath, bareRepoPath, cloned };
  });
}

/**
 * High-level: clean up a worktree after task completion.
 */
export function cleanupWorktree(bareRepoPath: string, worktreePath: string): void {
  removeWorktree(bareRepoPath, worktreePath);
}

/**
 * Run a command synchronously with sanitized error messages.
 */
function gitExec(command: string, args: string[], cwd?: string): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(sanitizeTokens(message));
  }
}
