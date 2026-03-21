import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
 * - First review of a repo: shallow clone to `<baseDir>/<owner>/<repo>/`
 * - Subsequent reviews: fetch PR ref into existing clone
 * - Checkout: `git fetch --force origin pull/<prNumber>/head && git checkout FETCH_HEAD`
 *
 * Uses `x-access-token` scheme when a GitHub token is provided (required for private repos).
 * All git operations use `--depth 1` for minimal disk/time footprint.
 *
 * @throws on git errors — callers should catch and fall back to diff-only review.
 */
export function cloneOrUpdate(
  owner: string,
  repo: string,
  prNumber: number,
  baseDir: string,
  githubToken?: string | null,
): CloneOrUpdateResult {
  validatePathSegment(owner, 'owner');
  validatePathSegment(repo, 'repo');

  const repoDir = path.join(baseDir, owner, repo);
  const cloneUrl = buildCloneUrl(owner, repo, githubToken);
  let cloned = false;

  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    // First clone — shallow
    fs.mkdirSync(path.join(baseDir, owner), { recursive: true });
    git(['clone', '--depth', '1', cloneUrl, repoDir]);
    cloned = true;
  }

  // Fetch the PR ref and checkout (--force handles force-pushed PRs)
  git(['fetch', '--force', '--depth', '1', 'origin', `pull/${prNumber}/head`], repoDir);
  git(['checkout', 'FETCH_HEAD'], repoDir);

  return { localPath: repoDir, cloned };
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
 * Build the clone URL, injecting a token for private repo access.
 */
export function buildCloneUrl(owner: string, repo: string, githubToken?: string | null): string {
  if (githubToken) {
    return `https://x-access-token:${githubToken}@github.com/${owner}/${repo}.git`;
  }
  return `https://github.com/${owner}/${repo}.git`;
}

/**
 * Strip embedded tokens from git error messages to prevent leakage.
 */
function sanitizeGitError(message: string): string {
  return message.replace(/x-access-token:[^@\s]+@/g, 'x-access-token:***@');
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
    throw new Error(sanitizeGitError(message));
  }
}
