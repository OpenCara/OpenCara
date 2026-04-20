import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { sanitizeTokens } from './sanitize.js';
import { validatePathSegment, isGhAvailable, buildCloneUrl } from './codebase.js';

/** Git credential helper arg that delegates to gh CLI */
const GH_CREDENTIAL_HELPER = '!gh auth git-credential';

/** Default timeout for git operations (2 minutes). */
const GIT_TIMEOUT_MS = 120_000;

/** Root config files to always include in sparse checkouts for review context. */
const SPARSE_ROOT_CONFIGS = [
  'package.json',
  'tsconfig.json',
  'tsconfig.base.json',
  '.eslintrc.json',
  '.eslintrc.js',
  '.prettierrc',
  '.prettierrc.json',
  'Cargo.toml',
  'go.mod',
  'pyproject.toml',
  'requirements.txt',
];

/**
 * Per-repo mutex to serialize git operations (fetch, worktree add/remove).
 * Multiple concurrent tasks on the same repo must not run git commands simultaneously
 * (git lock file conflicts).
 */
const repoLocks = new Map<string, Promise<void>>();

/**
 * Ref-count tracker for shared worktrees.
 * Key: worktree absolute path → number of active tasks using it.
 * When count drops to 0, the worktree is eligible for removal.
 */
const worktreeRefCounts = new Map<string, number>();

export interface WorktreeCheckoutResult {
  /** Absolute path to the worktree directory */
  worktreePath: string;
  /** Absolute path to the bare repo */
  bareRepoPath: string;
  /** Whether the bare repo was freshly cloned */
  cloned: boolean;
  /** Whether sparse checkout was used */
  sparse: boolean;
}

export interface SparseCheckoutOptions {
  /** File paths from the diff to include in sparse checkout */
  diffPaths: string[];
}

/**
 * Build the worktree directory name for a PR.
 * Uses `pr-<number>` instead of taskId so multiple tasks on the same PR share one worktree.
 */
export function prWorktreeKey(prNumber: number): string {
  return `pr-${prNumber}`;
}

/**
 * Acquire a per-repo lock, execute fn, then release.
 * Concurrent callers on the same repoKey queue behind the current holder.
 */
export async function withRepoLock<T>(repoKey: string, fn: () => T | Promise<T>): Promise<T> {
  const existing = repoLocks.get(repoKey);
  let release: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Always store gate directly — await existing for ordering
  repoLocks.set(repoKey, gate);

  try {
    if (existing) await existing;
    return await fn();
  } finally {
    release!();
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
  ghAvailable: boolean,
): { bareRepoPath: string; cloned: boolean } {
  validatePathSegment(owner, 'owner');
  validatePathSegment(repo, 'repo');

  const bareRepoPath = path.join(baseDir, owner, `${repo}.git`);

  if (fs.existsSync(path.join(bareRepoPath, 'HEAD'))) {
    return { bareRepoPath, cloned: false };
  }

  // Create parent dir
  fs.mkdirSync(path.join(baseDir, owner), { recursive: true });

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
export function fetchPRRef(bareRepoPath: string, prNumber: number, ghAvailable: boolean): void {
  const credArgs = ghAvailable ? ['-c', `credential.helper=${GH_CREDENTIAL_HELPER}`] : [];
  gitExec(
    'git',
    [...credArgs, 'fetch', '--force', 'origin', `pull/${prNumber}/head`],
    bareRepoPath,
  );
}

/**
 * Create a git worktree from the bare repo.
 * The worktree is checked out at FETCH_HEAD (the PR ref just fetched).
 *
 * Path: `<bareRepoPath>/../<repo>-worktrees/<worktreeKey>/`
 *
 * If the worktree already exists (shared PR worktree), returns the existing path
 * without creating a new one.
 */
export function addWorktree(bareRepoPath: string, worktreeKey: string): string {
  validatePathSegment(worktreeKey, 'worktreeKey');

  // Place worktrees alongside the bare repo for clean organization
  // e.g., <baseDir>/<owner>/<repo>-worktrees/<worktreeKey>/
  const repoName = path.basename(bareRepoPath, '.git');
  const worktreeBase = path.join(path.dirname(bareRepoPath), `${repoName}-worktrees`);
  const worktreePath = path.join(worktreeBase, worktreeKey);

  // If the worktree directory already exists, reuse it
  if (fs.existsSync(worktreePath)) {
    return worktreePath;
  }

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
 * Derive the repo key (owner/repo) from a bare repo path.
 * Bare repos are at `<baseDir>/<owner>/<repo>.git`.
 */
function repoKeyFromBarePath(bareRepoPath: string): string {
  const repoName = path.basename(bareRepoPath, '.git');
  const owner = path.basename(path.dirname(bareRepoPath));
  return `${owner}/${repoName}`;
}

/**
 * High-level: checkout a PR into an isolated worktree.
 *
 * Worktrees are keyed by PR number, not task ID. Multiple tasks for the same PR
 * share a single worktree, tracked via ref counting. The worktree is only removed
 * when the last task releases it via `cleanupWorktree`.
 *
 * 1. Ensure bare clone exists (or reuse cached)
 * 2. Fetch PR ref (with per-repo lock)
 * 3. Create or reuse worktree for this PR
 * 4. Increment ref count
 *
 * Returns the worktree path for use as cwd during review.
 */
export async function checkoutWorktree(
  owner: string,
  repo: string,
  prNumber: number,
  baseDir: string,
  _taskId?: string,
  sparseOptions?: SparseCheckoutOptions,
): Promise<WorktreeCheckoutResult> {
  validatePathSegment(owner, 'owner');
  validatePathSegment(repo, 'repo');

  const repoKey = `${owner}/${repo}`;
  const ghAvailable = isGhAvailable();
  const wtKey = prWorktreeKey(prNumber);
  const useSparse = !!sparseOptions && sparseOptions.diffPaths.length > 0;

  // Serialize all git operations per repo to avoid lock file conflicts
  return withRepoLock(repoKey, () => {
    // Always use the same bare clone (--filter=blob:none gives us partial clone).
    // Sparse checkout is a worktree concept — configured after worktree creation.
    const { bareRepoPath, cloned } = ensureBareClone(owner, repo, baseDir, ghAvailable);
    fetchPRRef(bareRepoPath, prNumber, ghAvailable);
    const worktreePath = addWorktree(bareRepoPath, wtKey);

    if (useSparse) {
      configureSparseCheckout(worktreePath, sparseOptions.diffPaths);
    }

    // Increment ref count
    const current = worktreeRefCounts.get(worktreePath) ?? 0;
    worktreeRefCounts.set(worktreePath, current + 1);

    return { worktreePath, bareRepoPath, cloned, sparse: useSparse };
  });
}

/**
 * High-level: clean up a worktree after task completion.
 *
 * Decrements the ref count for the worktree. Only actually removes it when
 * the ref count drops to 0 (no more tasks using it).
 * Acquires the per-repo lock to avoid racing with concurrent fetch/add operations.
 */
export async function cleanupWorktree(bareRepoPath: string, worktreePath: string): Promise<void> {
  const repoKey = repoKeyFromBarePath(bareRepoPath);
  await withRepoLock(repoKey, () => {
    const current = worktreeRefCounts.get(worktreePath) ?? 0;
    if (current > 1) {
      // Other tasks still using this worktree — just decrement
      worktreeRefCounts.set(worktreePath, current - 1);
      return;
    }

    // Last reference — remove the worktree
    worktreeRefCounts.delete(worktreePath);
    removeWorktree(bareRepoPath, worktreePath);
  });
}

/**
 * Get the current ref count for a worktree path.
 * Exported for testing only.
 */
export function getWorktreeRefCount(worktreePath: string): number {
  return worktreeRefCounts.get(worktreePath) ?? 0;
}

/**
 * Reset all worktree ref counts.
 * Exported for testing only.
 */
export function resetWorktreeRefCounts(): void {
  worktreeRefCounts.clear();
}

/**
 * Query GitHub API for repository size in KB.
 * Returns the size in KB, or null if the API call fails (e.g., gh not available).
 */
export function getRepoSize(owner: string, repo: string): number | null {
  try {
    const output = gitExec('gh', ['api', `repos/${owner}/${repo}`, '--jq', '.size']);
    const sizeKb = parseInt(output.trim(), 10);
    return isNaN(sizeKb) ? null : sizeKb;
  } catch {
    return null;
  }
}

/**
 * Parse a unified diff to extract the list of changed file paths.
 * Looks for `--- a/path` and `+++ b/path` headers, deduplicates results.
 * Returns an empty array if parsing fails or no files are found.
 */
export function parseDiffPaths(diff: string): string[] {
  const paths = new Set<string>();
  const lines = diff.split(/\r?\n/);
  for (const line of lines) {
    // Match +++ b/path or --- a/path (skip /dev/null for new/deleted files)
    const match = line.match(/^(?:\+\+\+|---) [ab]\/(.+)$/);
    if (match) {
      paths.add(match[1]);
    }
  }
  return [...paths];
}

/**
 * Build sparse-checkout patterns for the given file paths.
 * Includes the files themselves plus common root config files for context.
 */
export function buildSparsePatterns(filePaths: string[]): string[] {
  const patterns = new Set<string>(filePaths);

  // Add common root config files for review context
  for (const cfg of SPARSE_ROOT_CONFIGS) {
    patterns.add(cfg);
  }

  return [...patterns];
}

/**
 * Configure sparse-checkout on a worktree with the given file patterns.
 * Uses `--no-cone` mode for exact file matching.
 * Must be called with a worktree path (not a bare repo) since sparse-checkout
 * is a working-tree concept.
 */
export function configureSparseCheckout(worktreePath: string, filePaths: string[]): void {
  const patterns = buildSparsePatterns(filePaths);
  gitExec('git', ['sparse-checkout', 'set', '--no-cone', '--', ...patterns], worktreePath);
}

/**
 * Run a command synchronously with sanitized error messages.
 */
function gitExec(
  command: string,
  args: string[],
  cwd?: string,
  opts?: { maxBuffer?: number },
): string {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: 'utf-8',
      timeout: GIT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: opts?.maxBuffer,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(sanitizeTokens(message));
  }
}

/**
 * Generate a unified diff for a PR from a local worktree. Fetches the base
 * branch into the bare clone (idempotent) and runs
 * `git diff origin/<baseRef>...HEAD` inside the worktree.
 *
 * Unlike GitHub's REST diff endpoint (which caps at 300 files), the local
 * git diff has no such limit, so this is how we handle large PRs.
 *
 * The caller is responsible for holding the per-repo lock around this call.
 */
export function diffFromWorktree(
  bareRepoPath: string,
  worktreePath: string,
  baseRef: string,
  ghAvailable: boolean,
  maxDiffBytes = 128 * 1024 * 1024, // 128 MB
): string {
  // Defensive: reject ref names that look like option flags to avoid argv
  // injection if `baseRef` somehow leaks from untrusted input.
  if (baseRef.startsWith('-')) {
    throw new Error(`Invalid base ref: ${baseRef}`);
  }
  const credArgs = ghAvailable ? ['-c', `credential.helper=${GH_CREDENTIAL_HELPER}`] : [];
  gitExec(
    'git',
    [...credArgs, 'fetch', '--force', 'origin', `${baseRef}:refs/remotes/origin/${baseRef}`],
    bareRepoPath,
  );
  return gitExec('git', ['diff', `origin/${baseRef}...HEAD`], worktreePath, {
    maxBuffer: maxDiffBytes,
  });
}
