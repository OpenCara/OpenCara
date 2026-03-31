import { execFileSync } from 'node:child_process';
import type { PollTask, FixReport } from '@opencara/shared';
import type { ToolExecutorResult, TokenUsageDetail } from './tool-executor.js';
import { executeTool, estimateTokens } from './tool-executor.js';
import { sanitizeTokens } from './sanitize.js';
import type { Logger } from './logger.js';
import { buildFixPrompt } from './prompts.js';
export { buildFixPrompt };

// ── Constants ────────────────────────────────────────────────────

const TIMEOUT_SAFETY_MARGIN_MS = 30_000;

/** Default timeout for git operations (2 minutes). */
const GIT_TIMEOUT_MS = 120_000;

// ── Git Helpers ──────────────────────────────────────────────

/**
 * Run a git command synchronously in the given directory.
 * Returns stdout on success.
 */
function gitExec(args: string[], cwd: string): string {
  try {
    return execFileSync('git', args, {
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

/**
 * Checkout the PR branch in the worktree.
 * Throws if the branch does not exist on the remote.
 */
export function checkoutPRBranch(worktreePath: string, headRef: string): void {
  // Fetch the branch from origin
  gitExec(['fetch', 'origin', headRef], worktreePath);
  // Checkout the branch
  gitExec(['checkout', '-B', headRef, `origin/${headRef}`], worktreePath);
}

/**
 * Stage all changes, commit, and push to the PR branch.
 * Returns the commit SHA. Throws if push fails (never force-pushes).
 */
export function commitAndPush(
  worktreePath: string,
  headRef: string,
  prNumber: number,
): { commitSha: string; filesChanged: number } {
  // Stage all changes
  gitExec(['add', '-A'], worktreePath);

  // Check if there are any staged changes
  const status = gitExec(['status', '--porcelain'], worktreePath).trim();
  if (!status) {
    return { commitSha: '', filesChanged: 0 };
  }

  // Count files changed
  const filesChanged = status.split('\n').filter((line) => line.trim().length > 0).length;

  // Commit
  const commitMsg = `Fix review comments on PR #${prNumber}`;
  gitExec(['commit', '-m', commitMsg], worktreePath);

  // Get commit SHA
  const commitSha = gitExec(['rev-parse', 'HEAD'], worktreePath).trim();

  // Push — never force-push
  gitExec(['push', 'origin', headRef], worktreePath);

  return { commitSha, filesChanged };
}

// ── Error Types ────────────────────────────────────────────────────

export class BranchNotFoundError extends Error {
  constructor(headRef: string) {
    super(`PR branch '${headRef}' not found on remote`);
    this.name = 'BranchNotFoundError';
  }
}

export class PushFailedError extends Error {
  constructor(message: string) {
    super(`Push failed: ${message}`);
    this.name = 'PushFailedError';
  }
}

// ── Executor ────────────────────────────────────────────────

export interface FixResponse {
  report: FixReport;
  tokensUsed: number;
  tokensEstimated: boolean;
  tokenDetail: TokenUsageDetail;
}

export interface FixExecutorDeps {
  commandTemplate: string;
}

/**
 * Execute the AI fix tool: build prompt, run AI, return token usage.
 */
export async function executeFix(
  task: PollTask,
  diffContent: string,
  deps: FixExecutorDeps,
  timeoutSeconds: number,
  worktreePath: string,
  signal?: AbortSignal,
  runTool: (
    commandTemplate: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
    vars?: Record<string, string>,
    cwd?: string,
  ) => Promise<ToolExecutorResult> = executeTool,
): Promise<{ tokensUsed: number; tokensEstimated: boolean; tokenDetail: TokenUsageDetail }> {
  const timeoutMs = timeoutSeconds * 1000;
  if (timeoutMs <= TIMEOUT_SAFETY_MARGIN_MS) {
    throw new Error('Not enough time remaining to start fix');
  }

  const effectiveTimeout = timeoutMs - TIMEOUT_SAFETY_MARGIN_MS;
  const prompt = buildFixPrompt({
    owner: task.owner,
    repo: task.repo,
    prNumber: task.pr_number,
    diffContent,
    prReviewComments: task.pr_review_comments ?? '(no review comments provided)',
    customPrompt: task.prompt || undefined,
  });

  const result = await runTool(
    deps.commandTemplate,
    prompt,
    effectiveTimeout,
    signal,
    undefined,
    worktreePath,
  );

  // Compute token usage
  const inputTokens = result.tokensParsed ? 0 : estimateTokens(prompt);
  const detail = result.tokenDetail;
  const tokenDetail: TokenUsageDetail = result.tokensParsed
    ? detail
    : {
        input: inputTokens,
        output: detail.output,
        total: inputTokens + detail.output,
        parsed: false,
      };

  return {
    tokensUsed: result.tokensUsed + inputTokens,
    tokensEstimated: !result.tokensParsed,
    tokenDetail,
  };
}

/**
 * Execute a fix task end-to-end:
 * 1. Checkout PR branch
 * 2. Run AI tool to apply fixes
 * 3. Commit and push changes
 * 4. Submit result to server
 */
export async function executeFixTask(
  client: { post: <T>(path: string, body: unknown) => Promise<T> },
  agentId: string,
  task: PollTask,
  diffContent: string,
  deps: FixExecutorDeps,
  timeoutSeconds: number,
  worktreePath: string,
  logger: Logger,
  signal?: AbortSignal,
  runTool?: (
    commandTemplate: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
    vars?: Record<string, string>,
    cwd?: string,
  ) => Promise<ToolExecutorResult>,
): Promise<{ tokensUsed: number; tokensEstimated: boolean; tokenDetail: TokenUsageDetail }> {
  const { log } = logger;
  const headRef = task.head_ref;
  if (!headRef) {
    throw new BranchNotFoundError('(no head_ref provided)');
  }

  // Step 1: Checkout PR branch
  log(`  Checking out PR branch: ${headRef}`);
  try {
    checkoutPRBranch(worktreePath, headRef);
  } catch {
    throw new BranchNotFoundError(headRef);
  }

  // Step 2: Run AI tool to apply fixes
  log(`  Running AI fix tool...`);
  const tokenResult = await executeFix(
    task,
    diffContent,
    deps,
    timeoutSeconds,
    worktreePath,
    signal,
    runTool,
  );

  // Step 3: Commit and push
  log(`  Committing and pushing changes...`);
  let commitSha = '';
  let filesChanged = 0;
  try {
    const pushResult = commitAndPush(worktreePath, headRef, task.pr_number);
    commitSha = pushResult.commitSha;
    filesChanged = pushResult.filesChanged;
  } catch (err) {
    throw new PushFailedError((err as Error).message);
  }

  if (filesChanged === 0) {
    log(`  No changes detected — AI tool did not modify any files`);
  } else {
    log(`  Pushed ${filesChanged} file(s) changed (${commitSha.slice(0, 7)})`);
  }

  // Step 4: Count review comments addressed
  const commentsAddressed = countReviewComments(task.pr_review_comments ?? '');

  // Step 5: Submit result to server
  const fixReport: FixReport = {
    commit_sha: commitSha || undefined,
    files_changed: filesChanged,
    comments_addressed: commentsAddressed,
    summary:
      filesChanged > 0
        ? `Fixed ${commentsAddressed} review comment(s), ${filesChanged} file(s) changed`
        : 'AI tool ran but produced no file changes',
  };

  await client.post(`/api/tasks/${task.task_id}/result`, {
    agent_id: agentId,
    type: 'fix' as const,
    review_text: sanitizeTokens(fixReport.summary),
    tokens_used: tokenResult.tokensUsed,
    fix_report: fixReport,
  });

  log(`  Fix submitted (${tokenResult.tokensUsed.toLocaleString()} tokens)`);
  log(`    Files changed: ${filesChanged} | Comments addressed: ${commentsAddressed}`);

  return tokenResult;
}

/**
 * Count the number of review comments in the structured comments text.
 * Counts "### File:" and "### General Review Comment" headers.
 */
export function countReviewComments(commentsText: string): number {
  if (!commentsText) return 0;
  const headerPattern = /^### (?:File:|General Review Comment)/gm;
  const matches = commentsText.match(headerPattern);
  return matches ? matches.length : 0;
}
