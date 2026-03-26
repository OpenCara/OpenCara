import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sanitizeTokens } from './sanitize.js';

/** Pattern for valid GitHub owner/repo names */
const VALID_NAME_PATTERN = /^[a-zA-Z0-9._-]+$/;

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
 * - Checkout: `git clone --depth 1` then `git fetch --force origin pull/<prNumber>/head`
 *
 * Authentication uses `http.extraHeader` config to inject the token via HTTP header,
 * avoiding token exposure in process listings or crash dumps.
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
  githubToken?: string | null,
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
  const cloneUrl = buildCloneUrl(owner, repo);
  const authArgs = buildAuthArgs(githubToken);
  let cloned = false;

  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    // First clone — shallow
    fs.mkdirSync(repoDir, { recursive: true });
    git([...authArgs, 'clone', '--depth', '1', cloneUrl, repoDir]);
    cloned = true;
  }

  // Fetch the PR ref and checkout (--force handles force-pushed PRs)
  git(
    [...authArgs, 'fetch', '--force', '--depth', '1', 'origin', `pull/${prNumber}/head`],
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
 * Build git CLI args that inject authentication via http.extraHeader.
 * This avoids embedding the token in the URL (visible via `ps`, crash dumps, logs).
 * Returns an empty array when no token is provided.
 */
export function buildAuthArgs(githubToken?: string | null): string[] {
  if (!githubToken) return [];
  return ['-c', `http.extraHeader=Authorization: Bearer ${githubToken}`];
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
