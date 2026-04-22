import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PollTask, ImplementReport, TaskRole } from '@opencara/shared';
import type { ToolExecutorResult, TokenUsageDetail } from './tool-executor.js';
import {
  executeTool,
  estimateTokens,
  parseCommandTemplate,
  ToolTimeoutError,
} from './tool-executor.js';
import { sanitizeTokens } from './sanitize.js';
import { validatePathSegment, isGhAvailable, buildCloneUrl } from './codebase.js';
import { buildImplementPrompt } from './prompts.js';
export { buildImplementPrompt };

// ── Constants ────────────────────────────────────────────────────

/** Safety margin subtracted from task timeout before invoking AI tool. */
const TIMEOUT_SAFETY_MARGIN_MS = 30_000;

/** Default timeout for git operations (2 minutes). */
const GIT_TIMEOUT_MS = 120_000;

/** Maximum issue body size in bytes before truncation. */
export const MAX_ISSUE_BODY_BYTES = 30 * 1024; // 30KB — more context than triage

/** Git credential helper arg that delegates to gh CLI */
const GH_CREDENTIAL_HELPER = '!gh auth git-credential';

// ── Slug Helpers ─────────────────────────────────────────────────

/**
 * Create a URL-safe slug from a title string.
 * Lowercases, replaces non-alphanumeric with hyphens, trims, and truncates.
 */
export function slugify(title: string, maxLength: number = 50): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/, '');
}

/**
 * Build the branch name for an implement task.
 * Convention: `opencara/issue-<number>-<slug>`
 */
export function buildBranchName(issueNumber: number, title: string): string {
  const slug = slugify(title);
  return `opencara/issue-${issueNumber}-${slug}`;
}

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Truncate a string to a maximum byte length, appending a truncation notice.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;
  const truncated = buf
    .subarray(0, maxBytes)
    .toString('utf-8')
    .replace(/\uFFFD+$/, '');
  return truncated + '\n\n[... truncated ...]';
}

// ── Output Parsing ───────────────────────────────────────────────

export interface ImplementOutput {
  summary: string;
  filesChanged: string[];
}

/**
 * Extract a JSON object from AI output that may contain markdown fences or preamble.
 */
export function extractJsonFromOutput(output: string): string | null {
  // Try to find JSON in markdown code fences first
  const fenceMatch = output.match(/```(?:json)?\s*\n?([\s\S]+?)\n?\s*```/);
  if (fenceMatch && fenceMatch[1].trim().length > 0) {
    return fenceMatch[1].trim();
  }

  // Try to find a top-level JSON object
  const braceStart = output.indexOf('{');
  const braceEnd = output.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return output.slice(braceStart, braceEnd + 1);
  }

  return null;
}

/**
 * Parse AI output to extract the implement summary.
 * Falls back to using the full output as summary if JSON parsing fails.
 */
export function parseImplementOutput(output: string): ImplementOutput {
  const jsonStr = extractJsonFromOutput(output);
  if (jsonStr) {
    try {
      const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
      const summary =
        typeof parsed.summary === 'string' ? parsed.summary : 'Implementation completed';
      const filesChanged = Array.isArray(parsed.files_changed)
        ? parsed.files_changed.filter((f): f is string => typeof f === 'string')
        : [];
      return { summary, filesChanged };
    } catch {
      // Fall through to fallback
    }
  }

  // Fallback: use first 200 chars of output as summary
  const trimmed = output.trim();
  const summary = trimmed.length > 200 ? trimmed.slice(0, 200) + '...' : trimmed;
  return { summary: summary || 'Implementation completed', filesChanged: [] };
}

// ── Git Operations ───────────────────────────────────────────────

/**
 * Run a git command synchronously with sanitized error messages.
 */
function gitExec(args: string[], cwd?: string): string {
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
 * Run gh CLI command synchronously.
 */
function ghExec(args: string[], cwd?: string): string {
  try {
    return execFileSync('gh', args, {
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
 * Detect the default branch by trying known ref paths.
 * Non-bare repos use origin/main, origin/master; bare clones use refs/heads/main, refs/heads/master.
 */
export function detectDefaultBranch(repoPath: string): string {
  // Non-bare clone refs (remote tracking branches)
  const candidates: Array<{ ref: string; branch: string }> = [
    { ref: 'origin/main', branch: 'main' },
    { ref: 'origin/master', branch: 'master' },
    // Bare clone refs (local branches — no remote tracking in bare repos)
    { ref: 'refs/heads/main', branch: 'main' },
    { ref: 'refs/heads/master', branch: 'master' },
  ];

  for (const { ref, branch } of candidates) {
    try {
      gitExec(['rev-parse', '--verify', ref], repoPath);
      return branch;
    } catch {
      // Try next candidate
    }
  }

  throw new Error('Cannot determine default branch — neither main nor master exists');
}

/**
 * Resolve the start-point ref for worktree creation.
 * Prefers origin/<branch> (non-bare), falls back to refs/heads/<branch> (bare clone).
 */
export function resolveStartRef(repoPath: string, branch: string): string {
  try {
    gitExec(['rev-parse', '--verify', `origin/${branch}`], repoPath);
    return `origin/${branch}`;
  } catch {
    // Bare clone — use local ref
    return branch;
  }
}

export interface ImplementCheckoutResult {
  /** Absolute path to the worktree directory */
  worktreePath: string;
  /** Absolute path to the bare repo */
  bareRepoPath: string;
}

/**
 * Checkout a repo for implement task: bare clone + worktree on a new branch.
 * Unlike review worktrees (which detach at the fetched PR tip), this creates a
 * branch from the default branch for pushing changes.
 */
export function checkoutForImplement(
  owner: string,
  repo: string,
  issueNumber: number,
  branchName: string,
  baseDir: string,
): ImplementCheckoutResult {
  validatePathSegment(owner, 'owner');
  validatePathSegment(repo, 'repo');

  const ghAvailable = isGhAvailable();
  const bareRepoPath = path.join(baseDir, owner, `${repo}.git`);

  // Ensure bare clone exists
  if (!fs.existsSync(path.join(bareRepoPath, 'HEAD'))) {
    fs.mkdirSync(path.join(baseDir, owner), { recursive: true });
    if (ghAvailable) {
      ghExec([
        'repo',
        'clone',
        `${owner}/${repo}`,
        bareRepoPath,
        '--',
        '--bare',
        '--filter=blob:none',
      ]);
    } else {
      const cloneUrl = buildCloneUrl(owner, repo);
      gitExec(['clone', '--bare', '--filter=blob:none', cloneUrl, bareRepoPath]);
    }
  }

  // Fetch latest and force-update local refs (bare clones need explicit refspec
  // to update refs/heads/* when worktrees hold the branch)
  const credArgs = ghAvailable ? ['-c', `credential.helper=${GH_CREDENTIAL_HELPER}`] : [];
  gitExec([...credArgs, 'fetch', '--force', 'origin', '+refs/heads/*:refs/heads/*'], bareRepoPath);

  // Determine default branch (usually main or master).
  // In bare clones, refs live under refs/heads/ (not refs/remotes/origin/).
  let defaultBranch: string;
  try {
    defaultBranch = gitExec(
      ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'],
      bareRepoPath,
    ).trim();
    // Strip "origin/" prefix if present
    defaultBranch = defaultBranch.replace(/^origin\//, '');
  } catch {
    // Fallback: try origin/main, origin/master (non-bare), then refs/heads/ (bare)
    defaultBranch = detectDefaultBranch(bareRepoPath);
  }

  // Resolve the start point ref for worktree creation.
  // In bare clones, origin/<branch> doesn't exist — use refs/heads/<branch> instead.
  const startRef = resolveStartRef(bareRepoPath, defaultBranch);

  // Create worktree with new branch from default branch
  const worktreeBase = path.join(path.dirname(bareRepoPath), `${repo}-worktrees`);
  const worktreeKey = `implement-${issueNumber}`;
  const worktreePath = path.join(worktreeBase, worktreeKey);

  // Clean up if worktree already exists (stale from previous attempt)
  if (fs.existsSync(worktreePath)) {
    try {
      gitExec(['worktree', 'remove', '--force', worktreePath], bareRepoPath);
    } catch {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      gitExec(['worktree', 'prune'], bareRepoPath);
    }
  }

  // Delete branch if it exists from previous attempt
  try {
    gitExec(['branch', '-D', branchName], bareRepoPath);
  } catch {
    // Branch doesn't exist — expected
  }

  fs.mkdirSync(worktreeBase, { recursive: true });
  gitExec(['worktree', 'add', '-b', branchName, worktreePath, startRef], bareRepoPath);

  return { worktreePath, bareRepoPath };
}

/**
 * Clean up a worktree after implement task (success or failure).
 */
export function cleanupImplementWorktree(bareRepoPath: string, worktreePath: string): void {
  try {
    gitExec(['worktree', 'remove', '--force', worktreePath], bareRepoPath);
  } catch {
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      gitExec(['worktree', 'prune'], bareRepoPath);
    } catch {
      // Best-effort cleanup
    }
  }
}

/**
 * Count the number of changed files in the worktree (staged, unstaged, and untracked).
 */
export function countChangedFiles(worktreePath: string): number {
  const status = gitExec(['status', '--porcelain'], worktreePath);
  return status.split('\n').filter((line) => line.trim().length > 0).length;
}

/**
 * Stage all changes, commit, and push the branch.
 * Returns the number of files changed.
 */
export function commitAndPush(
  worktreePath: string,
  issueNumber: number,
  issueTitle: string,
): number {
  const filesChanged = countChangedFiles(worktreePath);
  if (filesChanged === 0) {
    throw new Error('No changes to commit — AI tool did not modify any files');
  }

  // Stage all changes
  gitExec(['add', '-A'], worktreePath);

  // Commit with human-readable title (truncated, not slugified)
  const truncatedTitle = issueTitle.length > 60 ? issueTitle.slice(0, 57) + '...' : issueTitle;
  const commitMsg = `Implement #${issueNumber}: ${truncatedTitle}`;
  gitExec(['commit', '-m', commitMsg], worktreePath);

  // Push with credential helper
  const ghAvailable = isGhAvailable();
  const credArgs = ghAvailable ? ['-c', `credential.helper=${GH_CREDENTIAL_HELPER}`] : [];
  gitExec([...credArgs, 'push', '-u', 'origin', 'HEAD'], worktreePath);

  return filesChanged;
}

/**
 * Create a PR via gh CLI.
 * Returns the PR number and URL.
 */
export function createPR(
  worktreePath: string,
  issueNumber: number,
  issueTitle: string,
  summary: string,
  branchName?: string,
): { prNumber: number; prUrl: string } {
  const title = `Implement #${issueNumber}: ${issueTitle}`;
  const body = [
    `Part of #${issueNumber}`,
    '',
    '## Summary',
    summary,
    '',
    '---',
    '*Automated by OpenCara implement agent*',
  ].join('\n');

  // Note: no --label flag — label may not exist on arbitrary repos.
  // Server/webhook handles labeling after PR creation.
  // Use --head to specify the branch explicitly — worktrees from bare clones
  // don't have upstream tracking visible to gh.
  const args = ['pr', 'create', '--title', title, '--body', body];
  if (branchName) {
    args.push('--head', branchName);
  }
  const output = ghExec(args, worktreePath);

  // Parse PR URL from gh output (last line is the URL)
  const prUrl = output.trim().split('\n').pop()?.trim() ?? '';
  const prNumberMatch = prUrl.match(/\/pull\/(\d+)/);
  if (!prNumberMatch) {
    throw new Error(`Failed to parse PR URL from gh output: ${output.trim().slice(0, 200)}`);
  }
  const prNumber = parseInt(prNumberMatch[1], 10);

  return { prNumber, prUrl };
}

// ── Executor ─────────────────────────────────────────────────────

export interface ImplementResponse {
  report: ImplementReport;
  tokensUsed: number;
  tokensEstimated: boolean;
  tokenDetail: TokenUsageDetail;
}

export interface ImplementExecutorDeps {
  commandTemplate: string;
  codebaseDir: string;
}

/**
 * Check if a command template uses agentic mode (prompt via arg, no --print).
 * Agentic mode lets the AI run as a full interactive agent with file access.
 */
export function isAgenticCommand(commandTemplate: string): boolean {
  return commandTemplate.includes('${PROMPT}') && !commandTemplate.includes('--print');
}

/**
 * Execute the AI tool in agentic mode — stdio: 'inherit', no stdout capture.
 * The AI handles everything (implement, commit, push, PR, review, merge).
 * Returns only the exit code; no output parsing.
 */
function executeAgentic(
  commandTemplate: string,
  prompt: string,
  timeoutMs: number,
  cwd: string,
  signal?: AbortSignal,
): Promise<{ exitCode: number }> {
  const allVars: Record<string, string> = { PROMPT: prompt, CODEBASE_DIR: cwd };
  const { command, args } = parseCommandTemplate(commandTemplate, allVars);

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ToolTimeoutError('Tool execution aborted'));
      return;
    }

    const child = spawn(command, args, {
      stdio: 'inherit',
      cwd,
    });

    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) {
        child.kill('SIGTERM');
        setTimeout(() => {
          if (!settled) child.kill('SIGKILL');
        }, 5000);
      }
    }, timeoutMs);

    let onAbort: (() => void) | undefined;
    if (signal) {
      onAbort = () => {
        if (!settled) child.kill('SIGTERM');
      };
      signal.addEventListener('abort', onAbort, { once: true });
    }

    child.on('error', (err) => {
      clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      reject(err);
    });

    child.on('close', (code, sig) => {
      clearTimeout(timer);
      if (onAbort && signal) signal.removeEventListener('abort', onAbort);
      if (settled) return;
      settled = true;
      if (sig === 'SIGTERM' || sig === 'SIGKILL') {
        reject(new ToolTimeoutError(`Tool timed out after ${Math.round(timeoutMs / 1000)}s`));
        return;
      }
      resolve({ exitCode: code ?? 1 });
    });
  });
}

/**
 * Execute the AI tool for an implement task.
 * Runs the tool in the worktree directory so it can read/modify files.
 */
export async function executeImplement(
  task: PollTask,
  worktreePath: string,
  deps: ImplementExecutorDeps,
  timeoutSeconds: number,
  signal?: AbortSignal,
  runTool: (
    commandTemplate: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
    vars?: Record<string, string>,
    cwd?: string,
  ) => Promise<ToolExecutorResult> = executeTool,
): Promise<{
  output: ImplementOutput;
  tokensUsed: number;
  tokensEstimated: boolean;
  tokenDetail: TokenUsageDetail;
  agentic: boolean;
}> {
  const timeoutMs = timeoutSeconds * 1000;
  if (timeoutMs <= TIMEOUT_SAFETY_MARGIN_MS) {
    throw new Error('Not enough time remaining to start implement task');
  }

  const effectiveTimeout = timeoutMs - TIMEOUT_SAFETY_MARGIN_MS;
  const prompt = buildImplementPrompt(task);

  // Agentic mode: AI handles everything, no output capture needed
  if (isAgenticCommand(deps.commandTemplate)) {
    const result = await executeAgentic(
      deps.commandTemplate,
      prompt,
      effectiveTimeout,
      worktreePath,
      signal,
    );
    return {
      output: {
        summary: result.exitCode === 0 ? 'Implementation completed' : 'Implementation failed',
        filesChanged: [],
      },
      tokensUsed: 0,
      tokensEstimated: true,
      tokenDetail: { input: 0, output: 0, total: 0, parsed: false },
      agentic: true,
    };
  }

  // Standard mode: capture stdout, parse output
  const result = await runTool(
    deps.commandTemplate,
    prompt,
    effectiveTimeout,
    signal,
    undefined,
    worktreePath,
  );

  const output = parseImplementOutput(result.stdout);

  // Compute token usage
  const inputTokens = result.tokensParsed ? 0 : estimateTokens(prompt);
  const tokenDetail: TokenUsageDetail = result.tokensParsed
    ? result.tokenDetail
    : {
        input: inputTokens,
        output: result.tokenDetail.output,
        total: inputTokens + result.tokenDetail.output,
        parsed: false,
      };

  return {
    output,
    tokensUsed: result.tokensUsed + inputTokens,
    tokensEstimated: !result.tokensParsed,
    tokenDetail,
    agentic: false,
  };
}

/**
 * Execute an implement task end-to-end:
 * checkout repo → create branch → run AI → commit → push → create PR → submit result.
 */
export async function executeImplementTask(
  client: { post: <T>(path: string, body: unknown) => Promise<T> },
  agentId: string,
  task: PollTask,
  deps: ImplementExecutorDeps,
  timeoutSeconds: number,
  logger: { log: (msg: string) => void },
  signal?: AbortSignal,
  runTool?: (
    commandTemplate: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
    vars?: Record<string, string>,
    cwd?: string,
  ) => Promise<ToolExecutorResult>,
  role: TaskRole = 'implement',
  // Dependency injection for git/gh operations (testing)
  gitOps: {
    checkoutForImplement: typeof checkoutForImplement;
    commitAndPush: typeof commitAndPush;
    createPR: typeof createPR;
    cleanupImplementWorktree: typeof cleanupImplementWorktree;
  } = { checkoutForImplement, commitAndPush, createPR, cleanupImplementWorktree },
): Promise<{ tokensUsed: number; tokensEstimated: boolean; tokenDetail: TokenUsageDetail }> {
  const issueNumber = task.issue_number ?? task.pr_number;
  const issueTitle = task.issue_title ?? `Issue #${issueNumber}`;
  logger.log(`  Implementing issue #${issueNumber}: ${issueTitle}`);

  const branchName = buildBranchName(issueNumber, issueTitle);
  let worktreePath: string | null = null;
  let bareRepoPath: string | null = null;

  try {
    // Step 1: Checkout repo and create branch
    logger.log(`  Checking out ${task.owner}/${task.repo} → branch ${branchName}`);
    const checkout = gitOps.checkoutForImplement(
      task.owner,
      task.repo,
      issueNumber,
      branchName,
      deps.codebaseDir,
    );
    worktreePath = checkout.worktreePath;
    bareRepoPath = checkout.bareRepoPath;

    // Step 2: Run AI tool in worktree
    logger.log('  Running AI tool...');
    const aiResult = await executeImplement(
      task,
      worktreePath,
      deps,
      timeoutSeconds,
      signal,
      runTool,
    );
    logger.log(`  AI completed (${aiResult.tokensUsed.toLocaleString()} tokens)`);

    // In agentic mode, the AI handles everything — skip executor post-processing
    if (aiResult.agentic) {
      logger.log('  Agentic mode — AI handled commit/push/PR/review/merge');
      // Try to submit result, but don't fail if claim expired (agent may have run for hours)
      try {
        await client.post(`/api/tasks/${task.task_id}/result`, {
          agent_id: agentId,
          type: role,
          review_text: sanitizeTokens(aiResult.output.summary),
          tokens_used: aiResult.tokensUsed,
        });
        logger.log('  Result submitted');
      } catch {
        logger.log(
          '  Result submission skipped (claim may have expired — normal for agentic mode)',
        );
      }
      return {
        tokensUsed: aiResult.tokensUsed,
        tokensEstimated: aiResult.tokensEstimated,
        tokenDetail: aiResult.tokenDetail,
      };
    }

    // Standard mode: executor handles commit/push/PR

    // Step 3: Commit and push (skip if AI already committed)
    let filesChanged = 0;
    let uncommitted = 0;
    try {
      uncommitted = countChangedFiles(worktreePath);
    } catch {
      uncommitted = 1;
    }
    if (uncommitted > 0) {
      logger.log('  Committing and pushing changes...');
      filesChanged = gitOps.commitAndPush(worktreePath, issueNumber, issueTitle);
      logger.log(`  Pushed ${filesChanged} file(s) to ${branchName}`);
    } else {
      logger.log('  No uncommitted changes — AI agent handled commit/push');
    }

    // Step 4: Create PR (skip if AI already created one)
    let prNumber = 0;
    let prUrl = '';
    try {
      logger.log('  Creating pull request...');
      const pr = gitOps.createPR(
        worktreePath,
        issueNumber,
        issueTitle,
        aiResult.output.summary,
        branchName,
      );
      prNumber = pr.prNumber;
      prUrl = pr.prUrl;
      logger.log(`  PR #${prNumber} created: ${prUrl}`);
    } catch (prErr) {
      try {
        const existing = ghExec(
          ['pr', 'list', '--head', branchName, '--json', 'number,url', '--limit', '1'],
          worktreePath,
        );
        const parsed = JSON.parse(existing) as Array<{ number: number; url: string }>;
        if (parsed.length > 0) {
          prNumber = parsed[0].number;
          prUrl = parsed[0].url;
          logger.log(`  PR #${prNumber} already exists: ${prUrl}`);
        } else {
          throw prErr;
        }
      } catch {
        throw prErr;
      }
    }

    // Step 5: Submit result to server
    const report: ImplementReport = {
      branch: branchName,
      pr_number: prNumber,
      pr_url: prUrl,
      files_changed: filesChanged,
      summary: aiResult.output.summary,
    };

    await client.post(`/api/tasks/${task.task_id}/result`, {
      agent_id: agentId,
      type: role,
      review_text: sanitizeTokens(aiResult.output.summary),
      tokens_used: aiResult.tokensUsed,
      implement_report: report,
    });

    logger.log(`  Implement result submitted (${aiResult.tokensUsed.toLocaleString()} tokens)`);

    return {
      tokensUsed: aiResult.tokensUsed,
      tokensEstimated: aiResult.tokensEstimated,
      tokenDetail: aiResult.tokenDetail,
    };
  } catch (err) {
    // Report error to server
    const errorMsg = err instanceof Error ? err.message : String(err);
    try {
      await client.post(`/api/tasks/${task.task_id}/error`, {
        agent_id: agentId,
        error: sanitizeTokens(errorMsg),
      });
    } catch (reportErr) {
      logger.log(
        `  Warning: failed to report error to server: ${reportErr instanceof Error ? reportErr.message : String(reportErr)}`,
      );
    }
    throw err;
  } finally {
    // Clean up worktree
    if (worktreePath && bareRepoPath) {
      try {
        gitOps.cleanupImplementWorktree(bareRepoPath, worktreePath);
      } catch {
        // Best-effort cleanup
      }
    }
  }
}
