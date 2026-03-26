import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sanitizeTokens } from './sanitize.js';

/** Pattern for valid GitHub owner/repo names */
const VALID_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

/** Git credential helper arg that delegates to gh CLI */
const GH_CREDENTIAL_HELPER = '!gh auth git-credential';

export interface CloneOrUpdateResult {
  /** Absolute path to the local checkout */
  localPath: string;
  /** Whether the repo was freshly cloned (true) or already existed (false) */
  cloned: boolean;
}

/**
 * Clone or update a GitHub repository for context-aware code review.
 *
 * - Each task gets its own isolated checkout at `<baseDir>/<owner>/<repo>/<taskId>/`
 *   to prevent concurrent reviews of the same repo from interfering.
 * - Clone: `gh repo clone` (handles auth internally) with fallback to unauthenticated `git clone`
 * - Fetch: `git fetch` with `gh auth git-credential` helper, fallback to plain fetch
 *
 * All git operations use `--depth 1` for minimal disk/time footprint.
 *
 * After review completes, callers should call `cleanupTaskDir()` to remove the
 * task-specific directory.
 *
 * @throws on git errors — callers should catch and fall back to diff-only review.
 */
export function cloneOrUpdate(
  owner: string,
  repo: string,
  prNumber: number,
  baseDir: string,
  taskId?: string,
): CloneOrUpdateResult {
  validatePathSegment(owner, 'owner');
  validatePathSegment(repo, 'repo');
  if (taskId) {
    validatePathSegment(taskId, 'taskId');
  }

  // Use task-specific subdirectory to isolate concurrent checkouts
  const repoDir = taskId
    ? path.join(baseDir, owner, repo, taskId)
    : path.join(baseDir, owner, repo);
  const ghAvailable = isGhAvailable();
  let cloned = false;

  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    // First clone — shallow
    if (ghAvailable) {
      // gh repo clone handles auth internally (like gh api)
      // Pass git args after -- for shallow clone
      ghClone(owner, repo, repoDir);
    } else {
      // Fallback: unauthenticated HTTPS clone (works for public repos)
      fs.mkdirSync(repoDir, { recursive: true });
      const cloneUrl = buildCloneUrl(owner, repo);
      git(['clone', '--depth', '1', cloneUrl, repoDir]);
    }
    cloned = true;
  }

  // Fetch the PR ref and checkout (--force handles force-pushed PRs)
  const credArgs = ghAvailable ? ['-c', `credential.helper=${GH_CREDENTIAL_HELPER}`] : [];
  git(
    [...credArgs, 'fetch', '--force', '--depth', '1', 'origin', `pull/${prNumber}/head`],
    repoDir,
  );
  git(['checkout', 'FETCH_HEAD'], repoDir);

  return { localPath: repoDir, cloned };
}

/**
 * Remove a task-specific checkout directory after review completes.
 * Refuses to delete shallow paths as a safety guard.
 * Ignores ENOENT (already removed), warns on other errors.
 */
export function cleanupTaskDir(dirPath: string): void {
  // Guard: must be an absolute path with sufficient depth to avoid deleting important dirs
  if (!path.isAbsolute(dirPath) || dirPath.split(path.sep).filter(Boolean).length < 3) {
    return;
  }
  try {
    fs.rmSync(dirPath, { recursive: true, force: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.warn(`[cleanup] Failed to remove ${dirPath}: ${(err as Error).message}`);
    }
  }
}

/**
 * Validate that a path segment (owner/repo name) is safe for filesystem use.
 * Rejects path traversal (..), slashes, and other unsafe characters.
 */
export function validatePathSegment(segment: string, name: string): void {
  if (!VALID_NAME_PATTERN.test(segment) || segment === '.' || segment === '..') {
    throw new Error(`Invalid ${name}: '${segment}' contains disallowed characters`);
  }
}

/**
 * Build the clone URL. Always returns a plain HTTPS URL without embedded credentials.
 */
export function buildCloneUrl(owner: string, repo: string): string {
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Check whether the `gh` CLI is installed and authenticated.
 * Returns true if `gh auth status` exits successfully.
 */
export function isGhAvailable(): boolean {
  try {
    execFileSync('gh', ['auth', 'status'], {
      encoding: 'utf-8',
      timeout: 10_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Clone a repository using `gh repo clone`, which handles auth internally.
 * Creates the target directory and performs a shallow clone.
 */
function ghClone(owner: string, repo: string, targetDir: string): void {
  try {
    // gh repo clone creates the target directory itself
    // Args after -- are passed to underlying git clone
    execFileSync('gh', ['repo', 'clone', `${owner}/${repo}`, targetDir, '--', '--depth', '1'], {
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(sanitizeTokens(message));
  }
}

/**
 * Run a git command synchronously.
 * Throws on non-zero exit. Sanitizes error messages to prevent token leakage.
 */
function git(args: string[], cwd?: string): string {
  try {
    return execFileSync('git', args, {
      cwd,
      encoding: 'utf-8',
      timeout: 120_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(sanitizeTokens(message));
  }
}
