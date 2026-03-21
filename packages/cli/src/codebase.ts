import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

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
 * - Checkout: `git fetch origin pull/<prNumber>/head && git checkout FETCH_HEAD`
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
  const repoDir = path.join(baseDir, owner, repo);
  const cloneUrl = buildCloneUrl(owner, repo, githubToken);
  let cloned = false;

  if (!fs.existsSync(path.join(repoDir, '.git'))) {
    // First clone — shallow
    fs.mkdirSync(path.join(baseDir, owner), { recursive: true });
    git(['clone', '--depth', '1', cloneUrl, repoDir]);
    cloned = true;
  }

  // Fetch the PR ref and checkout
  git(['fetch', '--depth', '1', 'origin', `pull/${prNumber}/head`], repoDir);
  git(['checkout', 'FETCH_HEAD'], repoDir);

  return { localPath: repoDir, cloned };
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
 * Run a git command synchronously.
 * Throws on non-zero exit.
 */
function git(args: string[], cwd?: string): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    timeout: 120_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}
