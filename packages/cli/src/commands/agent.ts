import { Command } from 'commander';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  PollResponse,
  PollTask,
  ClaimResponse,
  ClaimReview,
  ReviewVerdict,
  TaskRole,
  RepoConfig,
  BatchPollResponse,
} from '@opencara/shared';
import {
  isRepoAllowed,
  isDedupRole,
  isTriageRole,
  isFixRole,
  isImplementRole,
  isIssueReviewRole,
} from '@opencara/shared';
import {
  loadConfig,
  resolveCodebaseDir,
  DEFAULT_MAX_CONSECUTIVE_ERRORS,
  CONFIG_DIR,
  CONFIG_FILE,
  type LocalAgentConfig,
  type UsageLimits,
} from '../config.js';
import {
  checkoutWorktree,
  cleanupWorktree,
  diffFromWorktree,
  withRepoLock,
} from '../repo-cache.js';
import { isGhAvailable } from '../codebase.js';
import {
  parseTtl,
  CodebaseCleanupTracker,
  scanAndCleanStaleWorktrees,
  DEFAULT_CODEBASE_TTL_MS,
} from '../codebase-cleanup.js';
import { getValidToken, loadAuth, fetchUserOrgs, AuthError, ensureAuth } from '../auth.js';
import { ApiClient, HttpError, UpgradeRequiredError } from '../http.js';
import { withRetry, NonRetryableError } from '../retry.js';
import {
  executeReview,
  DiffTooLargeError,
  buildMetadataHeader,
  extractVerdict,
  type ReviewExecutorDeps,
  type ReviewMetadata,
} from '../review.js';
import {
  executeSummary,
  buildSummaryMetadataHeader,
  extractFlaggedReviews,
  InputTooLargeError,
  type FlaggedReview,
} from '../summary.js';
import { validateCommandBinary, estimateTokens, testCommand } from '../tool-executor.js';
import { RouterRelay } from '../router.js';
import {
  createSessionTracker,
  recordSessionUsage,
  formatPostReviewStats,
  type SessionStats,
  type RecordUsageOptions,
} from '../consumption.js';
import { UsageTracker } from '../usage-tracker.js';
import { sanitizeTokens } from '../sanitize.js';
import { detectSuspiciousPatterns } from '../prompt-guard.js';
import { executeDedupTask, defaultExecGh } from '../dedup.js';
import { fetchPRContext, formatPRContext, hasContent } from '../pr-context.js';
import { executeTriageTask, type TriageExecutorDeps } from '../triage.js';
import { executeIssueReviewTask, type IssueReviewExecutorDeps } from '../issue-review.js';
import { executeImplementTask, type ImplementExecutorDeps } from '../implement.js';
import {
  executeFixTask,
  BranchNotFoundError,
  PushFailedError,
  type FixExecutorDeps,
} from '../fix.js';
import {
  createLogger,
  createAgentSession,
  formatExitSummary,
  formatVersionBanner,
  formatAgentTools,
  logVerboseToolOutput,
  icons,
  type Logger,
  type AgentSessionStats,
} from '../logger.js';
import { interactiveSetup } from '../setup.js';
import { getToolDef } from '../tool-defs.js';
import {
  type AgentDescriptor,
  buildBatchPollRequest,
  filterTasksForAgent,
  agentConfigToDescriptor,
  verifyRepoAccess,
  extractRepoUrls,
  DEFAULT_RECHECK_INTERVAL,
} from '../batch-poll.js';

declare const __CLI_VERSION__: string;
declare const __GIT_COMMIT__: string;

/**
 * Resolve the command template for an agent config.
 * Priority: explicit command → global agentCommand → registry commandTemplate.
 */
function resolveCommandTemplate(
  agentConfig: LocalAgentConfig | undefined,
  globalCommand: string | null | undefined,
): string | undefined {
  // 1. Explicit command on agent config
  if (agentConfig?.command) return agentConfig.command;
  // 2. Global agentCommand fallback
  if (globalCommand) return globalCommand;
  // 3. Fall back to tool definition from tools/*.toml
  if (agentConfig?.tool) {
    const toolDef = getToolDef(agentConfig.tool);
    if (toolDef) {
      return toolDef.command.replaceAll('${MODEL}', agentConfig.model ?? '');
    }
  }
  return undefined;
}

export interface ConsumptionDeps {
  agentId: string;
  session: SessionStats;
  usageTracker?: UsageTracker;
  usageLimits?: UsageLimits;
  /** Per-agent limit overrides. maxTasksPerDay overrides global usageLimits.maxTasksPerDay. */
  agentLimits?: { maxTasksPerDay?: number | null };
}

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const MAX_CONSECUTIVE_AUTH_ERRORS = 3;
const MAX_POLL_BACKOFF_MS = 300_000; // 5 minutes

/** Grace period before forced exit after SIGTERM/SIGINT (ms). */
const SHUTDOWN_GRACE_MS = 5_000;

/**
 * Register SIGTERM/SIGINT handlers that abort the controller, log the signal,
 * and force-exit after a grace period if cleanup hangs.
 *
 * Returns a cleanup function that removes the listeners (for testing).
 */
export function registerShutdownHandlers(
  controller: AbortController,
  log: (msg: string) => void,
  graceMs = SHUTDOWN_GRACE_MS,
): () => void {
  let shutdownInitiated = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;

  const onSignal = (signal: string) => {
    if (shutdownInitiated) {
      // Second signal — force immediate exit
      log(`${icons.stop} Received ${signal} again — forcing exit`);
      process.exit(1);
    }
    shutdownInitiated = true;
    log(`${icons.stop} Received ${signal} — shutting down gracefully...`);
    controller.abort();

    // Force exit after grace period in case cleanup hangs
    forceTimer = setTimeout(() => {
      log(`${icons.stop} Shutdown timed out after ${graceMs / 1000}s — forcing exit`);
      process.exit(1);
    }, graceMs);
    // Unref so the timer doesn't keep the process alive if cleanup finishes
    forceTimer.unref();
  };

  const onSigint = () => onSignal('SIGINT');
  const onSigterm = () => onSignal('SIGTERM');

  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  return () => {
    process.removeListener('SIGINT', onSigint);
    process.removeListener('SIGTERM', onSigterm);
    if (forceTimer) clearTimeout(forceTimer);
  };
}

/** HTTP statuses that will never succeed on retry (auth/not-found). */
const NON_RETRYABLE_STATUSES = new Set([401, 403, 404]);

/**
 * Convert a GitHub web diff URL to the API equivalent.
 * e.g. https://github.com/owner/repo/pull/123.diff
 *   → https://api.github.com/repos/owner/repo/pulls/123
 *
 * GitHub web URLs don't accept OAuth tokens (gho_) for private repos,
 * but the API endpoint does when using Accept: application/vnd.github.v3.diff.
 */
function toApiDiffUrl(webUrl: string): string | null {
  const match = webUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\.diff)?$/);
  if (!match) return null;
  const [, owner, repo, prNumber] = match;
  return `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`;
}

/**
 * Try to fetch the PR diff using the `gh` CLI, which uses the user's own
 * GitHub credentials and works for private repos without a platform token.
 *
 * Returns the diff string on success, or null if `gh` is not available or fails.
 */
export async function fetchDiffViaGh(
  owner: string,
  repo: string,
  prNumber: number,
  signal?: AbortSignal,
): Promise<string | null> {
  const state: { stderr: string; err: (Error & { code?: string | number | null }) | null } = {
    stderr: '',
    err: null,
  };
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        'gh',
        [
          'api',
          `repos/${owner}/${repo}/pulls/${prNumber}`,
          '-H',
          'Accept: application/vnd.github.v3.diff',
        ],
        { maxBuffer: 50 * 1024 * 1024 }, // 50 MB
        (err, stdoutStr, stderrStr) => {
          if (err) {
            state.err = err;
            state.stderr = stderrStr ?? '';
            reject(err);
          } else {
            resolve(stdoutStr);
          }
        },
      );
      if (signal) {
        const onAbort = () => {
          child.kill();
          reject(new Error('aborted'));
        };
        if (signal.aborted) {
          onAbort();
        } else {
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
    });
    return stdout;
  } catch {
    // Return null so `fetchDiff` can cascade to the HTTP tier — the API
    // fallback is the whole point of returning here. We do log whatever
    // `gh` reported on stderr (sanitized) so that when the HTTP path also
    // fails, the operator can see both failure modes rather than just the
    // generic 404 "private repo" red herring.
    const trimmed = state.stderr.trim();
    if (trimmed.length > 0 && state.err?.code !== 'ENOENT') {
      console.warn(`[fetchDiffViaGh] gh api failed: ${sanitizeTokens(trimmed)}`);
    }
    return null;
  }
}

/**
 * Compute the roles this agent is willing to take based on its config.
 * Priority: roles field > review_only/synthesizer_only > default.
 */
export function computeRoles(agent: LocalAgentConfig): TaskRole[] {
  if (agent.roles && agent.roles.length > 0) return agent.roles as TaskRole[];
  if (agent.review_only) return ['review'];
  if (agent.synthesizer_only) return ['summary'];
  return ['review', 'summary', 'implement', 'fix'];
}

/** Diff fetch method identifier for logging. */
type DiffMethod = 'gh' | 'http';

/** Default timeout for diff fetch via HTTP (60 seconds — diffs can be large). */
const DIFF_FETCH_TIMEOUT_MS = 60_000;

/**
 * Fetch diff via HTTP with streaming size guard.
 */
async function fetchDiffHttp(
  url: string,
  headers: Record<string, string>,
  signal?: AbortSignal,
  maxDiffSizeKb?: number,
): Promise<string> {
  const maxBytes = maxDiffSizeKb ? maxDiffSizeKb * 1024 : Infinity;

  // Per-call timeout, combined with optional caller signal (e.g., shutdown)
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIFF_FETCH_TIMEOUT_MS);
  const onParentAbort = () => controller.abort();
  if (signal?.aborted) {
    controller.abort();
  } else {
    signal?.addEventListener('abort', onParentAbort);
  }

  let response: Response;
  try {
    response = await fetch(url, { headers, signal: controller.signal });
  } catch (err) {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onParentAbort);
    throw err;
  }
  clearTimeout(timer);
  signal?.removeEventListener('abort', onParentAbort);
  if (!response.ok) {
    const hint =
      response.status === 404
        ? '. If this is a private repo, ensure gh CLI is installed and authenticated: gh auth login'
        : '';
    const msg = `Failed to fetch diff: ${response.status} ${response.statusText}${hint}`;
    if (NON_RETRYABLE_STATUSES.has(response.status)) {
      throw new NonRetryableError(msg);
    }
    throw new Error(msg);
  }

  // Fast path: check Content-Length header before reading body
  if (maxBytes < Infinity) {
    const contentLength = parseInt(response.headers.get('content-length') ?? '', 10);
    if (!isNaN(contentLength) && contentLength > maxBytes) {
      if (response.body) {
        void response.body.cancel();
      }
      throw new DiffTooLargeError(
        `Diff too large (${Math.round(contentLength / 1024)}KB > ${maxDiffSizeKb}KB, from Content-Length)`,
      );
    }

    // Stream with size limit — Content-Length may be absent or incorrect
    if (response.body) {
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let totalBytes = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.length;
        if (totalBytes > maxBytes) {
          void reader.cancel();
          throw new DiffTooLargeError(`Diff too large (>${maxDiffSizeKb}KB)`);
        }
        chunks.push(value);
      }
      return new TextDecoder().decode(concatUint8Arrays(chunks, totalBytes));
    }
  }

  return response.text();
}

/**
 * Fetch the PR diff directly from GitHub.
 * Agent fetches diff itself — server never sends it.
 *
 * Strategy (in order):
 * 1. `gh` CLI — uses the user's own GitHub credentials, works for private repos
 * 2. Public HTTP fetch — unauthenticated or with platform OAuth token, works for public repos
 */
async function fetchDiff(
  diffUrl: string,
  owner: string,
  repo: string,
  prNumber: number,
  opts: {
    githubToken?: string | null;
    signal?: AbortSignal;
    maxDiffSizeKb?: number;
  },
): Promise<{ diff: string; method: DiffMethod }> {
  const { githubToken, signal, maxDiffSizeKb } = opts;

  // Tier 1: gh CLI — uses user's own GitHub credentials
  const ghDiff = await fetchDiffViaGh(owner, repo, prNumber, signal);
  if (ghDiff !== null) {
    if (maxDiffSizeKb) {
      const maxBytes = maxDiffSizeKb * 1024;
      if (ghDiff.length > maxBytes) {
        throw new DiffTooLargeError(
          `Diff too large (${Math.round(ghDiff.length / 1024)}KB > ${maxDiffSizeKb}KB)`,
        );
      }
    }
    return { diff: ghDiff, method: 'gh' };
  }

  // Tier 2: Public HTTP fetch (with platform OAuth token if available)
  const diff = await withRetry(
    () => {
      const headers: Record<string, string> = {};
      let url: string;

      const apiUrl = githubToken ? toApiDiffUrl(diffUrl) : null;
      if (apiUrl && githubToken) {
        url = apiUrl;
        headers['Authorization'] = `Bearer ${githubToken}`;
        headers['Accept'] = 'application/vnd.github.v3.diff';
      } else {
        url = diffUrl.endsWith('.diff') ? diffUrl : `${diffUrl}.diff`;
        if (githubToken) {
          headers['Authorization'] = `Bearer ${githubToken}`;
        }
      }

      return fetchDiffHttp(url, headers, signal, maxDiffSizeKb);
    },
    { maxAttempts: 2 },
    signal,
  );

  return { diff, method: 'http' };
}

/** Concatenate Uint8Array chunks into a single buffer. */
function concatUint8Arrays(chunks: Uint8Array[], totalLength: number): Uint8Array {
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/** Max times an agent will attempt a task that fails diff fetch before skipping it. */
const MAX_DIFF_FETCH_ATTEMPTS = 3;
const MAX_TASK_ERROR_ATTEMPTS = 3;

/** Weight penalty applied on each tool error (multiplicative). */
const WEIGHT_PENALTY_FACTOR = 0.5;
/** Minimum weight before agent is excluded from dispatch. */
const MIN_DISPATCH_WEIGHT = 0.1;
/** Weight recovery on successful task completion (additive, capped at 1.0). */
const WEIGHT_RECOVERY = 0.25;
/** Time (ms) for a paused agent's weight to passively recover to 1.0. */
const WEIGHT_RECOVERY_DURATION_MS = 30 * 60 * 1000;

/**
 * Poll → Claim → Review → Submit loop for a single agent.
 */
async function pollLoop(
  client: ApiClient,
  agentId: string,
  reviewDeps: ReviewExecutorDeps,
  consumptionDeps: ConsumptionDeps,
  agentInfo: { model: string; tool: string; thinking?: string },
  logger: Logger,
  agentSession: AgentSessionStats,
  options: {
    pollIntervalMs: number;
    maxConsecutiveErrors: number;
    routerRelay?: RouterRelay;
    reviewOnly?: boolean;
    repoConfig?: RepoConfig;
    roles?: TaskRole[];
    synthesizeRepos?: RepoConfig;
    signal?: AbortSignal;
    cleanupTracker?: CodebaseCleanupTracker;
    verbose?: boolean;
    agentOwner?: string;
    userOrgs?: ReadonlySet<string>;
  },
): Promise<void> {
  const {
    pollIntervalMs,
    maxConsecutiveErrors,
    routerRelay,
    reviewOnly,
    repoConfig,
    roles,
    synthesizeRepos,
    signal,
    cleanupTracker,
    verbose,
    agentOwner,
    userOrgs,
  } = options;
  const { log, logError, logWarn } = logger;

  log(`${icons.polling} Polling every ${pollIntervalMs / 1000}s...`);

  let consecutiveAuthErrors = 0;
  let consecutiveErrors = 0;
  /** Tasks that repeatedly failed diff fetch — skip on future polls. */
  const diffFailCounts = new Map<string, number>();

  while (!signal?.aborted) {
    // Check daily usage limits before polling
    if (consumptionDeps.usageTracker && consumptionDeps.usageLimits) {
      const limitStatus = consumptionDeps.usageTracker.checkLimits(
        consumptionDeps.usageLimits,
        consumptionDeps.agentLimits,
        consumptionDeps.agentId,
      );
      if (!limitStatus.allowed) {
        log(`${icons.stop} ${limitStatus.reason}. Stopping.`);
        break;
      }
      if (limitStatus.warning) {
        logWarn(`${icons.warn} Approaching limits: ${limitStatus.warning}`);
      }
    }

    try {
      // Poll for tasks — include declared repos so server can return matching private tasks.
      // Server validates permissions; sending repos here doesn't bypass access control.
      const pollBody: Record<string, unknown> = { agent_id: agentId };
      // github_username removed — identity derived from OAuth token server-side
      if (roles) pollBody.roles = roles;
      if (reviewOnly) pollBody.review_only = true;
      if (repoConfig?.list?.length) {
        pollBody.repos = repoConfig.list;
      }
      if (synthesizeRepos) pollBody.synthesize_repos = synthesizeRepos;
      if (agentInfo.model) pollBody.model = agentInfo.model;
      if (agentInfo.tool) pollBody.tool = agentInfo.tool;
      if (agentInfo.thinking) pollBody.thinking = agentInfo.thinking;
      const pollResponse = await client.post<PollResponse>('/api/tasks/poll', pollBody);

      consecutiveAuthErrors = 0;
      consecutiveErrors = 0;

      // Filter tasks by repo config, diff size estimate, and diff fetch failure count
      const maxDiffSizeKb = reviewDeps.maxDiffSizeKb;
      const eligibleTasks = pollResponse.tasks.filter((t) => {
        if (repoConfig && !isRepoAllowed(repoConfig, t.owner, t.repo, agentOwner, userOrgs)) {
          return false;
        }
        // Skip tasks whose diff_size (lines) clearly exceeds maxDiffSizeKb.
        // Use ~120 bytes/line as a conservative upper estimate for unified diff format.
        if (maxDiffSizeKb && t.diff_size != null && (t.diff_size * 120) / 1024 > maxDiffSizeKb) {
          return false;
        }
        return true;
      });
      const task = eligibleTasks.find(
        (t) => (diffFailCounts.get(t.task_id) ?? 0) < MAX_DIFF_FETCH_ATTEMPTS,
      );

      // Sweep deferred codebase cleanups
      if (cleanupTracker) {
        const swept = await cleanupTracker.sweep(cleanupWorktree);
        if (swept > 0) {
          log(
            `${icons.info} Cleaned up ${swept} stale codebase director${swept === 1 ? 'y' : 'ies'}`,
          );
        }
      }

      if (task) {
        const result = await handleTask(
          client,
          agentId,
          task,
          reviewDeps,
          consumptionDeps,
          agentInfo,
          logger,
          agentSession,
          routerRelay,
          signal,
          cleanupTracker,
          verbose,
        );
        if (result.diffFetchFailed) {
          agentSession.errorsEncountered++;
          const count = (diffFailCounts.get(task.task_id) ?? 0) + 1;
          diffFailCounts.set(task.task_id, count);
          if (count >= MAX_DIFF_FETCH_ATTEMPTS) {
            logWarn(`  Skipping task ${task.task_id} after ${count} diff fetch failures`);
          }
        }
      }
    } catch (err) {
      if (signal?.aborted) break;

      // 426 Upgrade Required — graceful shutdown, no retry
      if (err instanceof UpgradeRequiredError) {
        logWarn(`${icons.warn} ${err.message}`);
        process.exitCode = 1;
        break;
      }

      agentSession.errorsEncountered++;

      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        consecutiveAuthErrors++;
        consecutiveErrors++;
        logError(
          `${icons.error} Auth error (${err.status}): ${err.message} [${consecutiveAuthErrors}/${MAX_CONSECUTIVE_AUTH_ERRORS}]`,
        );
        if (consecutiveAuthErrors >= MAX_CONSECUTIVE_AUTH_ERRORS) {
          logError(`${icons.error} Authentication failed repeatedly. Exiting.`);
          process.exitCode = 1;
          break;
        }
      } else {
        consecutiveAuthErrors = 0;
        consecutiveErrors++;
        logError(`${icons.error} Poll error: ${(err as Error).message}`);
      }

      // Exit after too many consecutive errors
      if (consecutiveErrors >= maxConsecutiveErrors) {
        logError(
          `Too many consecutive errors (${consecutiveErrors}/${maxConsecutiveErrors}). Shutting down.`,
        );
        process.exitCode = 1;
        break;
      }

      // Exponential backoff on consecutive failures
      if (consecutiveErrors > 0) {
        const backoff = Math.min(
          pollIntervalMs * Math.pow(2, consecutiveErrors - 1),
          MAX_POLL_BACKOFF_MS,
        );
        const extraDelay = backoff - pollIntervalMs;
        if (extraDelay > 0) {
          logWarn(
            `Poll failed (${consecutiveErrors} consecutive). Next poll in ${Math.round(backoff / 1000)}s`,
          );
          await sleep(extraDelay, signal);
        }
      }
    }

    // Wait before next poll
    await sleep(pollIntervalMs, signal);
  }
}

/** Result from handleTask indicating what happened. */
interface HandleTaskResult {
  diffFetchFailed?: boolean;
  toolFailed?: boolean;
}

/**
 * Handle a single task: claim → fetch diff → review → submit
 */
async function handleTask(
  client: ApiClient,
  agentId: string,
  task: PollTask,
  reviewDeps: ReviewExecutorDeps,
  consumptionDeps: ConsumptionDeps,
  agentInfo: { model: string; tool: string; thinking?: string },
  logger: Logger,
  agentSession: AgentSessionStats,
  routerRelay?: RouterRelay,
  signal?: AbortSignal,
  cleanupTracker?: CodebaseCleanupTracker,
  verbose?: boolean,
): Promise<HandleTaskResult> {
  const { task_id, owner, repo, pr_number, diff_url, timeout_seconds, prompt, role, base_ref } =
    task;
  const { log, logError, logWarn } = logger;

  const isIssueTask = pr_number === 0;
  if (isIssueTask) {
    const issueRef = task.issue_number ? `issue #${task.issue_number}` : 'issue';
    log(`${icons.success} Claimed task ${task_id} (${role}) — ${owner}/${repo} ${issueRef}`);
  } else {
    log(`${icons.success} Claimed task ${task_id} (${role}) — ${owner}/${repo}#${pr_number}`);
    log(`  https://github.com/${owner}/${repo}/pull/${pr_number}`);
  }

  // Claim the task (retry once — slot may be taken)
  // On failure, server returns structured error (e.g. CLAIM_CONFLICT, TASK_NOT_FOUND)
  // which the ApiClient converts to an HttpError.
  let claimResponse: ClaimResponse;
  try {
    const claimBody: Record<string, unknown> = {
      agent_id: agentId,
      role,
      model: agentInfo.model,
      tool: agentInfo.tool,
      thinking: agentInfo.thinking,
    };
    // github_username removed — identity derived from OAuth token server-side
    claimResponse = await withRetry(
      () => client.post<ClaimResponse>(`/api/tasks/${task_id}/claim`, claimBody),
      { maxAttempts: 2 },
      signal,
    );
  } catch (err) {
    if (err instanceof HttpError) {
      const codeInfo = err.errorCode ? ` [${err.errorCode}]` : '';
      logError(`  Claim rejected${codeInfo}: ${err.message}`);
    } else {
      logError(`  Failed to claim task ${task_id}: ${(err as Error).message}`);
    }
    return {};
  }

  // Issue-based tasks (issue_triage, issue_dedup) have no diff, codebase, or PR context
  let diffContent = '';
  let taskReviewDeps = reviewDeps;
  let taskCheckoutPath: string | null = null;
  let taskBareRepoPath: string | null = null;
  let contextBlock: string | undefined;

  if (isIssueTask) {
    log('  Issue-based task — skipping diff fetch');
  } else {
    // Checkout codebase first — a local worktree lets us compute the diff
    // via `git diff` instead of GitHub's REST diff endpoint, which caps at
    // 300 files. Sparse checkout is only applied when both a diff is
    // available up-front (via the API) AND the repo exceeds the configured
    // size cap; in the git-diff path we always do a full checkout since we
    // don't know the diff paths ahead of time.
    const codebaseDir = reviewDeps.codebaseDir || path.join(CONFIG_DIR, 'repos');
    try {
      const result = await checkoutWorktree(owner, repo, pr_number, codebaseDir, task_id);
      const mode = result.cloned ? 'cloned' : 'cached';
      log(`  Codebase ${mode} → worktree: ${result.worktreePath}`);
      taskCheckoutPath = result.worktreePath;
      taskBareRepoPath = result.bareRepoPath;
      taskReviewDeps = { ...reviewDeps, codebaseDir: result.worktreePath };
    } catch (err) {
      logWarn(
        `  Warning: worktree checkout failed: ${(err as Error).message}. Will try API diff only.`,
      );
      taskReviewDeps = { ...reviewDeps, codebaseDir: null };
    }

    // Prefer local git diff when a worktree is available — handles PRs of
    // any size and works for private repos without a platform token.
    if (taskCheckoutPath && taskBareRepoPath && base_ref) {
      try {
        // Hoist `gh auth status` outside the repo lock — it's independent of
        // the repo and does a synchronous subprocess call (up to 10s timeout).
        const ghAvailable = isGhAvailable();
        const maxDiffBytes = reviewDeps.maxDiffSizeKb ? reviewDeps.maxDiffSizeKb * 1024 : undefined;
        const repoKey = `${owner}/${repo}`;
        const gitDiff = await withRepoLock(repoKey, () =>
          diffFromWorktree(
            taskBareRepoPath!,
            taskCheckoutPath!,
            base_ref,
            ghAvailable,
            maxDiffBytes,
          ),
        );
        if (maxDiffBytes !== undefined && gitDiff.length > maxDiffBytes) {
          throw new DiffTooLargeError(
            `Diff too large (${Math.round(gitDiff.length / 1024)}KB > ${reviewDeps.maxDiffSizeKb}KB)`,
          );
        }
        diffContent = gitDiff;
        log(`  Diff generated via git (${Math.round(diffContent.length / 1024)}KB)`);
      } catch (err) {
        if (err instanceof DiffTooLargeError) {
          logError(`  ${(err as Error).message}`);
          await safeReject(
            client,
            task_id,
            agentId,
            `Cannot access diff: ${(err as Error).message}`,
            logger,
          );
          return { diffFetchFailed: true };
        }
        logWarn(
          `  Warning: git diff failed (${(err as Error).message}) — falling back to API fetch`,
        );
      }
    }

    // Fallback: fetch via gh CLI / HTTP API.
    if (!diffContent) {
      try {
        const result = await fetchDiff(diff_url, owner, repo, pr_number, {
          githubToken: client.currentToken,
          signal,
          maxDiffSizeKb: reviewDeps.maxDiffSizeKb,
        });
        diffContent = result.diff;
        log(`  Diff fetched via ${result.method} (${Math.round(diffContent.length / 1024)}KB)`);
      } catch (err) {
        logError(`  Failed to fetch diff for task ${task_id}: ${(err as Error).message}`);
        await safeReject(
          client,
          task_id,
          agentId,
          `Cannot access diff: ${(err as Error).message}`,
          logger,
        );
        return { diffFetchFailed: true };
      }
    }

    // Fetch PR context (metadata, comments, reviews) — non-blocking on failure
    try {
      const prContext = await fetchPRContext(owner, repo, pr_number, {
        githubToken: client.currentToken,
        signal,
      });
      if (hasContent(prContext)) {
        contextBlock = formatPRContext(prContext, taskReviewDeps.codebaseDir);
        log('  PR context fetched');
      }
    } catch (err) {
      logWarn(
        `  Warning: failed to fetch PR context: ${(err as Error).message}. Continuing without.`,
      );
    }
  }

  // Check repo prompt for suspicious patterns (prompt injection attempts)
  const guardResult = detectSuspiciousPatterns(prompt);
  if (guardResult.suspicious) {
    logWarn(
      `  ${icons.warn} Suspicious patterns detected in repo prompt: ${guardResult.patterns.map((p) => p.name).join(', ')}`,
    );
    // Best-effort report to server — endpoint may not exist yet
    try {
      await client.post(`/api/tasks/${task_id}/report`, {
        agent_id: agentId,
        type: 'suspicious_prompt',
        details: guardResult.patterns,
      });
    } catch {
      // Server may not support this endpoint yet — log and continue
      log('  (suspicious prompt report not sent — endpoint not available)');
    }
  }

  // Execute review, summary, dedup, triage, fix, or implement
  try {
    if (isImplementRole(role)) {
      const codebaseDir = reviewDeps.codebaseDir || path.join(CONFIG_DIR, 'repos');
      const implementDeps: ImplementExecutorDeps = {
        commandTemplate: reviewDeps.commandTemplate,
        codebaseDir,
      };
      const implementResult = await executeImplementTask(
        client,
        agentId,
        task,
        implementDeps,
        timeout_seconds,
        logger,
        signal,
        undefined,
        role,
      );
      recordSessionUsage(consumptionDeps.session, {
        inputTokens: implementResult.tokenDetail.input,
        outputTokens: implementResult.tokenDetail.output,
        totalTokens: implementResult.tokensUsed,
        estimated: implementResult.tokensEstimated,
      });
      if (consumptionDeps.usageTracker) {
        consumptionDeps.usageTracker.recordTask(
          {
            input: implementResult.tokenDetail.input,
            output: implementResult.tokenDetail.output,
            estimated: implementResult.tokensEstimated,
          },
          consumptionDeps.agentId,
        );
      }
    } else if (isFixRole(role)) {
      if (!taskCheckoutPath) {
        throw new Error('Fix task requires a codebase worktree but checkout failed');
      }
      const fixDeps: FixExecutorDeps = {
        commandTemplate: reviewDeps.commandTemplate,
      };
      const fixResult = await executeFixTask(
        client,
        agentId,
        task,
        diffContent,
        fixDeps,
        timeout_seconds,
        taskCheckoutPath,
        logger,
        signal,
      );
      recordSessionUsage(consumptionDeps.session, {
        inputTokens: fixResult.tokenDetail.input,
        outputTokens: fixResult.tokenDetail.output,
        totalTokens: fixResult.tokensUsed,
        estimated: fixResult.tokensEstimated,
      });
      if (consumptionDeps.usageTracker) {
        consumptionDeps.usageTracker.recordTask(
          {
            input: fixResult.tokenDetail.input,
            output: fixResult.tokenDetail.output,
            estimated: fixResult.tokensEstimated,
          },
          consumptionDeps.agentId,
        );
      }
    } else if (isTriageRole(role)) {
      const triageDeps: TriageExecutorDeps = {
        commandTemplate: reviewDeps.commandTemplate,
      };
      const triageResult = await executeTriageTask(
        client,
        agentId,
        task,
        triageDeps,
        timeout_seconds,
        logger,
        signal,
        undefined,
        role,
      );
      recordSessionUsage(consumptionDeps.session, {
        inputTokens: triageResult.tokenDetail.input,
        outputTokens: triageResult.tokenDetail.output,
        totalTokens: triageResult.tokensUsed,
        estimated: triageResult.tokensEstimated,
      });
      if (consumptionDeps.usageTracker) {
        consumptionDeps.usageTracker.recordTask(
          {
            input: triageResult.tokenDetail.input,
            output: triageResult.tokenDetail.output,
            estimated: triageResult.tokensEstimated,
          },
          consumptionDeps.agentId,
        );
      }
    } else if (isIssueReviewRole(role)) {
      const issueReviewDeps: IssueReviewExecutorDeps = {
        commandTemplate: reviewDeps.commandTemplate,
      };
      const issueReviewResult = await executeIssueReviewTask(
        client,
        agentId,
        task,
        issueReviewDeps,
        timeout_seconds,
        logger,
        signal,
      );
      recordSessionUsage(consumptionDeps.session, {
        inputTokens: issueReviewResult.tokenDetail.input,
        outputTokens: issueReviewResult.tokenDetail.output,
        totalTokens: issueReviewResult.tokensUsed,
        estimated: issueReviewResult.tokensEstimated,
      });
      if (consumptionDeps.usageTracker) {
        consumptionDeps.usageTracker.recordTask(
          {
            input: issueReviewResult.tokenDetail.input,
            output: issueReviewResult.tokenDetail.output,
            estimated: issueReviewResult.tokensEstimated,
          },
          consumptionDeps.agentId,
        );
      }
    } else if (isDedupRole(role)) {
      await executeDedupTask(
        client,
        agentId,
        task_id,
        {
          owner,
          repo,
          pr_number,
          issue_title: task.issue_title,
          issue_body: task.issue_body,
          diff_url,
          index_issue_body: task.index_issue_body,
          prompt,
        },
        diffContent,
        timeout_seconds,
        taskReviewDeps,
        consumptionDeps,
        logger,
        signal,
        role,
        { execGh: defaultExecGh },
      );
    } else if (role === 'summary' && 'reviews' in claimResponse && claimResponse.reviews) {
      await executeSummaryTask(
        client,
        agentId,
        task_id,
        owner,
        repo,
        pr_number,
        diffContent,
        prompt,
        timeout_seconds,
        claimResponse.reviews,
        taskReviewDeps,
        consumptionDeps,
        logger,
        agentInfo,
        routerRelay,
        signal,
        contextBlock,
        verbose,
      );
    } else {
      await executeReviewTask(
        client,
        agentId,
        task_id,
        owner,
        repo,
        pr_number,
        diffContent,
        prompt,
        timeout_seconds,
        taskReviewDeps,
        consumptionDeps,
        logger,
        agentInfo,
        routerRelay,
        signal,
        contextBlock,
        verbose,
      );
    }
    agentSession.tasksCompleted++;
  } catch (err) {
    agentSession.errorsEncountered++;
    if (err instanceof DiffTooLargeError || err instanceof InputTooLargeError) {
      logError(`  ${icons.error} ${err.message}`);
      await safeReject(client, task_id, agentId, err.message, logger);
    } else if (err instanceof BranchNotFoundError) {
      logError(`  ${icons.error} ${err.message}`);
      await safeReject(client, task_id, agentId, err.message, logger);
    } else if (err instanceof PushFailedError) {
      logError(`  ${icons.error} ${err.message}`);
      await safeError(client, task_id, agentId, err.message, logger);
    } else {
      logError(`  ${icons.error} Error on task ${task_id}: ${(err as Error).message}`);
      await safeError(client, task_id, agentId, (err as Error).message, logger);
    }
    return { toolFailed: true };
  } finally {
    // Clean up task worktree (bare repo stays for reuse)
    if (taskCheckoutPath && taskBareRepoPath) {
      if (cleanupTracker) {
        // Deferred cleanup: track for removal after TTL expires
        cleanupTracker.track(taskBareRepoPath, taskCheckoutPath);
      } else {
        // Immediate cleanup (no tracker = ttl is 0 or not configured)
        await cleanupWorktree(taskBareRepoPath, taskCheckoutPath);
      }
    }
  }
  return {};
}

/**
 * Report a task rejection to the server. Retry once, then log locally.
 */
async function safeReject(
  client: ApiClient,
  taskId: string,
  agentId: string,
  reason: string,
  logger: Logger,
): Promise<void> {
  try {
    await withRetry(
      () =>
        client.post(`/api/tasks/${taskId}/reject`, {
          agent_id: agentId,
          reason: sanitizeTokens(reason),
        }),
      { maxAttempts: 2 },
    );
  } catch (err) {
    logger.logError(
      `  Failed to report rejection for task ${taskId}: ${(err as Error).message} (logged locally)`,
    );
  }
}

/**
 * Report a task error to the server. Retry once, then log locally.
 */
async function safeError(
  client: ApiClient,
  taskId: string,
  agentId: string,
  error: string,
  logger: Logger,
): Promise<void> {
  try {
    await withRetry(
      () =>
        client.post(`/api/tasks/${taskId}/error`, {
          agent_id: agentId,
          error: sanitizeTokens(error),
        }),
      { maxAttempts: 2 },
    );
  } catch (err) {
    logger.logError(
      `  Failed to report error for task ${taskId}: ${(err as Error).message} (logged locally)`,
    );
  }
}

async function executeReviewTask(
  client: ApiClient,
  agentId: string,
  taskId: string,
  owner: string,
  repo: string,
  prNumber: number,
  diffContent: string,
  prompt: string,
  timeoutSeconds: number,
  reviewDeps: ReviewExecutorDeps,
  consumptionDeps: ConsumptionDeps,
  logger: Logger,
  agentInfo: { model: string; tool: string; thinking?: string },
  routerRelay?: RouterRelay,
  signal?: AbortSignal,
  contextBlock?: string,
  verbose?: boolean,
): Promise<void> {
  // Check per-review token limit before executing.
  // Uses estimated *input* tokens only — output tokens are unpredictable and
  // can't be known before execution. The limit acts as a guard against
  // sending excessively large prompts to the AI tool.
  if (consumptionDeps.usageLimits?.maxTokensPerReview != null && consumptionDeps.usageTracker) {
    const estimatedInput = estimateTokens(diffContent + prompt + (contextBlock ?? ''));
    const perReviewCheck = consumptionDeps.usageTracker.checkPerReviewLimit(
      estimatedInput,
      consumptionDeps.usageLimits,
    );
    if (!perReviewCheck.allowed) {
      throw new Error(perReviewCheck.reason);
    }
  }

  let reviewText: string;
  let verdict: ReviewVerdict;
  let tokensUsed: number;
  let usageOpts: RecordUsageOptions | undefined;

  if (routerRelay) {
    // Router mode: relay to external agent
    logger.log(`  ${icons.running} Executing review: [router mode]`);
    const fullPrompt = routerRelay.buildReviewPrompt({
      owner,
      repo,
      reviewMode: 'compact',
      prompt,
      diffContent,
      contextBlock,
    });
    const response = await routerRelay.sendPrompt(
      'review_request',
      taskId,
      fullPrompt,
      timeoutSeconds,
    );
    const parsed = routerRelay.parseReviewResponse(response);
    reviewText = parsed.review;
    verdict = parsed.verdict as ReviewVerdict;
    tokensUsed = estimateTokens(fullPrompt) + estimateTokens(response);
    usageOpts = {
      inputTokens: estimateTokens(fullPrompt),
      outputTokens: estimateTokens(response),
      totalTokens: tokensUsed,
      estimated: true,
    };
  } else {
    // Direct mode: execute tool locally
    logger.log(`  ${icons.running} Executing review: ${reviewDeps.commandTemplate}`);
    const result = await executeReview(
      {
        taskId,
        diffContent,
        prompt,
        owner,
        repo,
        prNumber,
        timeout: timeoutSeconds,
        reviewMode: 'compact',
        contextBlock,
      },
      reviewDeps,
    );
    reviewText = result.review;
    verdict = result.verdict;
    tokensUsed = result.tokensUsed;
    usageOpts = {
      inputTokens: result.tokenDetail.input,
      outputTokens: result.tokenDetail.output,
      totalTokens: result.tokensUsed,
      estimated: result.tokensEstimated,
    };
    if (verbose) {
      logVerboseToolOutput(
        logger,
        'Review',
        result.toolStdout,
        result.toolStderr,
        result.promptLength,
      );
    }
  }

  // Prepend metadata header (covers both router and direct paths)
  const reviewMeta: ReviewMetadata = {
    model: agentInfo.model,
    tool: agentInfo.tool,
  };
  const headerReview = buildMetadataHeader(verdict, reviewMeta);

  // Sanitize review text before submission to prevent token leakage
  const sanitizedReview = sanitizeTokens(headerReview + reviewText);

  // Submit result — retry up to 3 times (highest-risk operation)
  await withRetry(
    () =>
      client.post(`/api/tasks/${taskId}/result`, {
        agent_id: agentId,
        type: 'review' as TaskRole,
        review_text: sanitizedReview,
        verdict,
        tokens_used: tokensUsed,
      }),
    { maxAttempts: 3 },
    signal,
  );

  recordSessionUsage(consumptionDeps.session, usageOpts);
  // Record to persistent usage tracker
  if (consumptionDeps.usageTracker) {
    consumptionDeps.usageTracker.recordTask(
      {
        input: usageOpts.inputTokens,
        output: usageOpts.outputTokens,
        estimated: usageOpts.estimated,
      },
      consumptionDeps.agentId,
    );
  }
  logger.log(`  ${icons.success} Review submitted (${tokensUsed.toLocaleString()} tokens)`);
  logger.log(formatPostReviewStats(consumptionDeps.session));
}

async function executeSummaryTask(
  client: ApiClient,
  agentId: string,
  taskId: string,
  owner: string,
  repo: string,
  prNumber: number,
  diffContent: string,
  prompt: string,
  timeoutSeconds: number,
  reviews: ClaimReview[],
  reviewDeps: ReviewExecutorDeps,
  consumptionDeps: ConsumptionDeps,
  logger: Logger,
  agentInfo: { model: string; tool: string; thinking?: string },
  routerRelay?: RouterRelay,
  signal?: AbortSignal,
  contextBlock?: string,
  verbose?: boolean,
): Promise<void> {
  const meta: ReviewMetadata = { model: agentInfo.model, tool: agentInfo.tool };

  if (reviews.length === 0) {
    // Single-agent mode (review_count=1): this IS the review, run it as a regular
    // review but submit as 'summary' to match the claimed role.
    let reviewText: string;
    let verdict: ReviewVerdict | undefined;
    let tokensUsed: number;
    let usageOpts: RecordUsageOptions;

    if (routerRelay) {
      logger.log(`  ${icons.running} Executing summary: [router mode]`);
      const fullPrompt = routerRelay.buildReviewPrompt({
        owner,
        repo,
        reviewMode: 'full',
        prompt,
        diffContent,
        contextBlock,
      });
      const response = await routerRelay.sendPrompt(
        'review_request',
        taskId,
        fullPrompt,
        timeoutSeconds,
      );
      const parsed = routerRelay.parseReviewResponse(response);
      reviewText = parsed.review;
      verdict = parsed.verdict as ReviewVerdict;
      tokensUsed = estimateTokens(fullPrompt) + estimateTokens(response);
      usageOpts = {
        inputTokens: estimateTokens(fullPrompt),
        outputTokens: estimateTokens(response),
        totalTokens: tokensUsed,
        estimated: true,
      };
    } else {
      logger.log(`  ${icons.running} Executing summary: ${reviewDeps.commandTemplate}`);
      const result = await executeReview(
        {
          taskId,
          diffContent,
          prompt,
          owner,
          repo,
          prNumber,
          timeout: timeoutSeconds,
          reviewMode: 'full',
          contextBlock,
        },
        reviewDeps,
      );
      reviewText = result.review;
      verdict = result.verdict;
      tokensUsed = result.tokensUsed;
      usageOpts = {
        inputTokens: result.tokenDetail.input,
        outputTokens: result.tokenDetail.output,
        totalTokens: result.tokensUsed,
        estimated: result.tokensEstimated,
      };
      if (verbose) {
        logVerboseToolOutput(
          logger,
          'Summary (single-agent)',
          result.toolStdout,
          result.toolStderr,
          result.promptLength,
        );
      }
    }

    // Prepend metadata header (covers both router and direct paths)
    const headerSingle = buildMetadataHeader(verdict ?? 'comment', meta);
    const sanitizedReview = sanitizeTokens(headerSingle + reviewText);

    await withRetry(
      () =>
        client.post(`/api/tasks/${taskId}/result`, {
          agent_id: agentId,
          type: 'summary' as TaskRole,
          review_text: sanitizedReview,
          verdict,
          tokens_used: tokensUsed,
        }),
      { maxAttempts: 3 },
      signal,
    );

    recordSessionUsage(consumptionDeps.session, usageOpts);
    if (consumptionDeps.usageTracker) {
      consumptionDeps.usageTracker.recordTask(
        {
          input: usageOpts.inputTokens,
          output: usageOpts.outputTokens,
          estimated: usageOpts.estimated,
        },
        consumptionDeps.agentId,
      );
    }
    logger.log(
      `  ${icons.success} Review submitted as summary (${tokensUsed.toLocaleString()} tokens)`,
    );
    logger.log(formatPostReviewStats(consumptionDeps.session));
    return;
  }

  const summaryReviews = reviews.map((r) => ({
    agentId: r.agent_id,
    model: r.model ?? 'unknown',
    tool: r.tool ?? 'unknown',
    review: r.review_text,
    verdict: r.verdict as string,
  }));

  let summaryText: string;
  let summaryVerdict: ReviewVerdict;
  let tokensUsed: number;
  let usageOpts: RecordUsageOptions;
  let flaggedReviews: FlaggedReview[] = [];

  if (routerRelay) {
    logger.log(`  ${icons.running} Executing summary: [router mode]`);
    const fullPrompt = routerRelay.buildSummaryPrompt({
      owner,
      repo,
      prompt,
      reviews: summaryReviews,
      diffContent,
      contextBlock,
    });
    const response = await routerRelay.sendPrompt(
      'summary_request',
      taskId,
      fullPrompt,
      timeoutSeconds,
    );
    const parsed = extractVerdict(response);
    summaryText = parsed.review;
    summaryVerdict = parsed.verdict;
    flaggedReviews = extractFlaggedReviews(response);
    tokensUsed = estimateTokens(fullPrompt) + estimateTokens(response);
    usageOpts = {
      inputTokens: estimateTokens(fullPrompt),
      outputTokens: estimateTokens(response),
      totalTokens: tokensUsed,
      estimated: true,
    };
  } else {
    logger.log(`  ${icons.running} Executing summary: ${reviewDeps.commandTemplate}`);
    const result = await executeSummary(
      {
        taskId,
        reviews: summaryReviews,
        prompt,
        owner,
        repo,
        prNumber,
        timeout: timeoutSeconds,
        diffContent,
        contextBlock,
      },
      reviewDeps,
    );
    summaryText = result.summary;
    summaryVerdict = result.verdict;
    flaggedReviews = result.flaggedReviews;
    tokensUsed = result.tokensUsed;
    usageOpts = {
      inputTokens: result.tokenDetail.input,
      outputTokens: result.tokenDetail.output,
      totalTokens: result.tokensUsed,
      estimated: result.tokensEstimated,
    };
    if (verbose) {
      logVerboseToolOutput(
        logger,
        'Summary',
        result.toolStdout,
        result.toolStderr,
        result.promptLength,
      );
    }
  }

  if (flaggedReviews.length > 0) {
    logger.logWarn(
      `  ${icons.warn} Flagged reviews: ${flaggedReviews.map((f) => f.agentId).join(', ')}`,
    );
  }

  // Prepend metadata header (covers both router and direct paths)
  const summaryMeta = {
    ...meta,
    reviewerModels: summaryReviews.map((r) => `${r.model}/${r.tool}`),
  };
  const headerSummary = buildSummaryMetadataHeader(summaryVerdict, summaryMeta);
  const sanitizedSummary = sanitizeTokens(headerSummary + summaryText);

  // Submit result — retry up to 3 times (highest-risk operation)
  const resultBody: Record<string, unknown> = {
    agent_id: agentId,
    type: 'summary' as TaskRole,
    review_text: sanitizedSummary,
    verdict: summaryVerdict,
    tokens_used: tokensUsed,
  };
  if (flaggedReviews.length > 0) {
    resultBody.flagged_reviews = flaggedReviews;
  }
  await withRetry(
    () => client.post(`/api/tasks/${taskId}/result`, resultBody),
    { maxAttempts: 3 },
    signal,
  );

  recordSessionUsage(consumptionDeps.session, usageOpts);
  if (consumptionDeps.usageTracker) {
    consumptionDeps.usageTracker.recordTask(
      {
        input: usageOpts.inputTokens,
        output: usageOpts.outputTokens,
        estimated: usageOpts.estimated,
      },
      consumptionDeps.agentId,
    );
  }
  logger.log(`  ${icons.success} Summary submitted (${tokensUsed.toLocaleString()} tokens)`);
  logger.log(formatPostReviewStats(consumptionDeps.session));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * Start an agent in polling mode.
 */
export async function startAgent(
  agentId: string,
  platformUrl: string,
  agentInfo: { model: string; tool: string; thinking?: string },
  reviewDeps?: ReviewExecutorDeps,
  consumptionDeps?: ConsumptionDeps,
  options?: {
    pollIntervalMs?: number;
    maxConsecutiveErrors?: number;
    routerRelay?: RouterRelay;
    reviewOnly?: boolean;
    repoConfig?: RepoConfig;
    roles?: TaskRole[];
    synthesizeRepos?: RepoConfig;
    label?: string;
    authToken?: string | null;
    onTokenRefresh?: () => Promise<string>;
    usageLimits?: UsageLimits;
    versionOverride?: string | null;
    codebaseTtl?: string | null;
    verbose?: boolean;
    agentOwner?: string;
    userOrgs?: ReadonlySet<string>;
    commandTestTimeoutMs?: number;
  },
): Promise<void> {
  const client = new ApiClient(platformUrl, {
    authToken: options?.authToken,
    cliVersion: __CLI_VERSION__,
    versionOverride: options?.versionOverride,
    onTokenRefresh: options?.onTokenRefresh,
  });
  const session = consumptionDeps?.session ?? createSessionTracker();
  const usageTracker = consumptionDeps?.usageTracker ?? new UsageTracker();
  const usageLimits = options?.usageLimits ?? {
    maxTasksPerDay: null,
    maxTokensPerDay: null,
    maxTokensPerReview: null,
  };
  const deps: ConsumptionDeps = consumptionDeps
    ? {
        ...consumptionDeps,
        usageTracker: consumptionDeps.usageTracker ?? usageTracker,
        usageLimits: consumptionDeps.usageLimits ?? usageLimits,
      }
    : { agentId, session, usageTracker, usageLimits };
  const logger = createLogger(options?.label);
  const { log, logError, logWarn } = logger;

  const agentSession = createAgentSession();

  log(`${icons.start} Agent started (polling ${platformUrl})`);
  const thinkingInfo = agentInfo.thinking ? ` | Thinking: ${agentInfo.thinking}` : '';
  log(`Model: ${agentInfo.model} | Tool: ${agentInfo.tool}${thinkingInfo}`);
  if (options?.versionOverride) {
    log(`${icons.info} Version override active: ${options.versionOverride}`);
  }
  if (options?.verbose) {
    log(`${icons.info} Verbose mode enabled — tool stdout/stderr will be logged`);
  }

  if (!reviewDeps) {
    logError(`${icons.error} No review command configured. Set command in config.toml`);
    return;
  }

  // Dry-run test: verify command works before entering poll loop.
  // Skip in router mode (stdin/stdout relay) since there's no local command to test.
  if (reviewDeps.commandTemplate && !options?.routerRelay) {
    log('Testing command...');
    const result = await testCommand(reviewDeps.commandTemplate, options?.commandTestTimeoutMs);
    if (result.ok) {
      log(`${icons.success} Command test ok (${(result.elapsedMs / 1000).toFixed(1)}s)`);
    } else {
      logWarn(`${icons.warn} Command test failed (${result.error}). Reviews may fail.`);
    }
  }

  // Resolve codebase TTL for cleanup.
  // When not configured (null), default to 0 (immediate cleanup) to preserve existing behavior.
  // Users opt into deferred cleanup by setting codebase_ttl in config.toml.
  const ttlMs = options?.codebaseTtl != null ? parseTtl(options.codebaseTtl) : 0;
  const codebaseDir = reviewDeps.codebaseDir || path.join(CONFIG_DIR, 'repos');

  // Startup scan: remove stale worktree directories from previous runs.
  // Use DEFAULT_CODEBASE_TTL_MS as the minimum scan threshold to avoid removing
  // worktrees that are still in use by a recently-crashed agent.
  const scanTtl = Math.max(ttlMs, DEFAULT_CODEBASE_TTL_MS);
  const staleCount = scanAndCleanStaleWorktrees(codebaseDir, scanTtl);
  if (staleCount > 0) {
    log(
      `${icons.info} Cleaned up ${staleCount} stale codebase director${staleCount === 1 ? 'y' : 'ies'} on startup`,
    );
  }

  // Create cleanup tracker for deferred worktree removal (TTL > 0)
  const cleanupTracker = ttlMs > 0 ? new CodebaseCleanupTracker(ttlMs) : undefined;

  const abortController = new AbortController();
  const removeShutdownHandlers = registerShutdownHandlers(abortController, log);

  try {
    await pollLoop(client, agentId, reviewDeps, deps, agentInfo, logger, agentSession, {
      pollIntervalMs: options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      maxConsecutiveErrors: options?.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS,
      routerRelay: options?.routerRelay,
      reviewOnly: options?.reviewOnly,
      repoConfig: options?.repoConfig,
      roles: options?.roles,
      synthesizeRepos: options?.synthesizeRepos,
      signal: abortController.signal,
      cleanupTracker,
      verbose: options?.verbose,
      agentOwner: options?.agentOwner,
      userOrgs: options?.userOrgs,
    });

    // Final sweep: clean up any remaining tracked worktrees on shutdown
    if (cleanupTracker && cleanupTracker.size > 0) {
      const finalSwept = await cleanupTracker.sweep(cleanupWorktree);
      if (finalSwept > 0) {
        log(
          `${icons.info} Cleaned up ${finalSwept} codebase director${finalSwept === 1 ? 'y' : 'ies'} on shutdown`,
        );
      }
    }

    // Print usage summary on shutdown
    if (deps.usageTracker) {
      log(
        deps.usageTracker.formatSummary(
          deps.usageLimits ?? usageLimits,
          deps.agentLimits,
          deps.agentId,
        ),
      );
    }
    log(formatExitSummary(agentSession));
  } finally {
    removeShutdownHandlers();
  }
}

// ── Batch Poll Coordinator ────────────────────────────────────

/** Per-agent state tracked by the batch poll coordinator. */
interface BatchAgentState {
  descriptor: AgentDescriptor;
  reviewDeps: ReviewExecutorDeps;
  consumptionDeps: ConsumptionDeps;
  logger: Logger;
  agentSession: AgentSessionStats;
  routerRelay?: RouterRelay;
  cleanupTracker?: CodebaseCleanupTracker;
  verbose?: boolean;
  /** Tasks that repeatedly failed diff fetch — skip on future polls. */
  diffFailCounts: Map<string, number>;
  /** Tasks that repeatedly failed tool execution — skip on future polls. */
  taskErrorCounts: Map<string, number>;
  /** Dispatch weight (0.0–1.0). Starts at 1.0, decreases on tool errors, recovers on success. */
  weight: number;
  /** Timestamp of the last weight update — used for time-based passive recovery. */
  lastWeightUpdateAt: number;
  /** Whether a "paused" warning has already been logged for the current below-threshold period. */
  pausedLogged: boolean;
}

/**
 * Single batch poll loop that replaces N independent per-agent poll loops.
 * Polls once via the batch endpoint, then dispatches tasks to per-agent workers.
 */
export async function batchPollLoop(
  client: ApiClient,
  agentStates: BatchAgentState[],
  options: {
    pollIntervalMs: number;
    maxConsecutiveErrors: number;
    signal?: AbortSignal;
    recheckInterval?: number;
    accessibleRepos?: Set<string>;
    githubToken?: string;
  },
): Promise<void> {
  const {
    pollIntervalMs,
    maxConsecutiveErrors,
    signal,
    recheckInterval = DEFAULT_RECHECK_INTERVAL,
    accessibleRepos,
    githubToken,
  } = options;

  // Use a dedicated logger for coordinator-level messages
  const coordLogger = createLogger('batch');
  const { log, logError, logWarn } = coordLogger;

  log(
    `${icons.polling} Batch polling every ${pollIntervalMs / 1000}s for ${agentStates.length} agent(s)...`,
  );

  let consecutiveAuthErrors = 0;
  let consecutiveErrors = 0;
  let pollCycleCount = 0;

  // Track agents currently executing a task so we don't assign them a second one
  const busyAgents = new Set<BatchAgentState>();
  // Track in-flight task promises so we can await them on shutdown
  const inflightPromises = new Set<Promise<void>>();

  while (!signal?.aborted) {
    // Periodic repo access re-check
    if (
      accessibleRepos &&
      githubToken &&
      recheckInterval > 0 &&
      pollCycleCount > 0 &&
      pollCycleCount % recheckInterval === 0
    ) {
      const allRepos = extractRepoUrls(
        agentStates.map((s) => ({
          repos: s.descriptor.repoConfig,
          synthesize_repos: s.descriptor.synthesizeRepos,
        })),
      );
      if (allRepos.length > 0) {
        log(`${icons.info} Re-checking repo access (cycle ${pollCycleCount})...`);
        const result = await verifyRepoAccess(allRepos, githubToken);
        const newAccessible = new Set(result.accessible);
        // Report changes
        for (const repo of result.inaccessible) {
          if (accessibleRepos.has(repo)) {
            logWarn(`${icons.warn} Lost access to ${repo}`);
          }
        }
        for (const repo of result.accessible) {
          if (!accessibleRepos.has(repo)) {
            log(`${icons.success} Gained access to ${repo}`);
          }
        }
        accessibleRepos.clear();
        for (const repo of newAccessible) accessibleRepos.add(repo);
        if (accessibleRepos.size === 0) {
          logError(`${icons.error} No accessible repos remaining. Shutting down.`);
          process.exitCode = 1;
          break;
        }
      }
    }
    pollCycleCount++;

    // Check usage limits for all agents
    let allLimited = true;
    for (const state of agentStates) {
      const { consumptionDeps } = state;
      if (consumptionDeps.usageTracker && consumptionDeps.usageLimits) {
        const limitStatus = consumptionDeps.usageTracker.checkLimits(
          consumptionDeps.usageLimits,
          consumptionDeps.agentLimits,
          consumptionDeps.agentId,
        );
        if (limitStatus.allowed) {
          allLimited = false;
          if (limitStatus.warning) {
            state.logger.logWarn(`${icons.warn} Approaching limits: ${limitStatus.warning}`);
          }
        }
      } else {
        allLimited = false;
      }
    }
    if (allLimited) {
      log(`${icons.stop} All agents have reached usage limits. Stopping.`);
      break;
    }

    try {
      // Only poll for agents that are not currently handling a task
      const availableStates = agentStates.filter((s) => !busyAgents.has(s));
      if (availableStates.length === 0) {
        await sleep(pollIntervalMs, signal);
        continue;
      }

      // Build and send batch poll request for available agents only
      const descriptors = availableStates.map((s) => s.descriptor);
      const request = buildBatchPollRequest(descriptors);
      const response = await client.post<BatchPollResponse>('/api/tasks/poll/batch', request);

      consecutiveAuthErrors = 0;
      consecutiveErrors = 0;

      // Passive weight recovery: each agent's weight drifts back to 1.0 over
      // WEIGHT_RECOVERY_DURATION_MS of wall-clock time since its last update.
      const now = Date.now();
      for (const s of availableStates) {
        if (s.weight < 1.0) {
          const elapsed = now - s.lastWeightUpdateAt;
          const recovered = Math.min(1.0, s.weight + elapsed / WEIGHT_RECOVERY_DURATION_MS);
          if (recovered > s.weight) {
            s.weight = recovered;
            if (s.weight >= MIN_DISPATCH_WEIGHT && s.pausedLogged) {
              s.logger.log(
                `${icons.info} Agent resumed (weight ${s.weight.toFixed(2)} ≥ ${MIN_DISPATCH_WEIGHT})`,
              );
              s.pausedLogged = false;
            }
          }
        }
        s.lastWeightUpdateAt = now;
      }

      // Dispatch tasks to per-agent workers using weighted random selection.
      // Agents with higher weight (fewer recent errors) are more likely to be dispatched first.
      // Agents below MIN_DISPATCH_WEIGHT are temporarily excluded.
      const eligibleStates = availableStates.filter((s) => s.weight >= MIN_DISPATCH_WEIGHT);

      // Weighted shuffle: sort by weight * random, so higher-weight agents are more likely first
      const dispatchOrder = eligibleStates
        .map((s) => ({ state: s, score: s.weight * Math.random() }))
        .sort((a, b) => b.score - a.score)
        .map((e) => e.state);

      // Log agents excluded due to low weight — only once per pause period.
      for (const s of availableStates) {
        if (s.weight < MIN_DISPATCH_WEIGHT && !s.pausedLogged) {
          s.logger.logWarn(
            `${icons.warn} Agent paused (weight ${s.weight.toFixed(2)} < ${MIN_DISPATCH_WEIGHT}), recovering over ${WEIGHT_RECOVERY_DURATION_MS / 60000}m`,
          );
          s.pausedLogged = true;
        }
      }

      for (const state of dispatchOrder) {
        const agentName = state.descriptor.name;
        const pollResponse = response.assignments[agentName];
        if (!pollResponse || pollResponse.tasks.length === 0) continue;

        // Filter tasks for this agent
        const eligible = filterTasksForAgent(
          pollResponse.tasks,
          state.descriptor,
          state.reviewDeps.maxDiffSizeKb,
          state.diffFailCounts,
          MAX_DIFF_FETCH_ATTEMPTS,
          accessibleRepos,
          (msg) => state.logger.logWarn(`${icons.warn} ${msg}`),
        );

        // Skip tasks this agent has failed too many times
        const task = eligible.find(
          (t) => (state.taskErrorCounts.get(t.task_id) ?? 0) < MAX_TASK_ERROR_ATTEMPTS,
        );
        if (!task) continue;

        // Mark agent busy and dispatch task in the background so other agents
        // can start immediately — no waiting for this agent to finish.
        busyAgents.add(state);
        const p: Promise<void> = (async () => {
          try {
            const result = await handleTask(
              client,
              state.descriptor.agentId,
              task,
              state.reviewDeps,
              state.consumptionDeps,
              {
                model: state.descriptor.model,
                tool: state.descriptor.tool,
                thinking: state.descriptor.thinking,
              },
              state.logger,
              state.agentSession,
              state.routerRelay,
              signal,
              state.cleanupTracker,
              state.verbose,
            );
            if (result.diffFetchFailed) {
              state.agentSession.errorsEncountered++;
              const count = (state.diffFailCounts.get(task.task_id) ?? 0) + 1;
              state.diffFailCounts.set(task.task_id, count);
              if (count >= MAX_DIFF_FETCH_ATTEMPTS) {
                state.logger.logWarn(
                  `  Skipping task ${task.task_id} after ${count} diff fetch failures`,
                );
              }
              state.weight = Math.max(0, state.weight * WEIGHT_PENALTY_FACTOR);
              state.lastWeightUpdateAt = Date.now();
              state.logger.logWarn(
                `${icons.warn} Weight reduced to ${state.weight.toFixed(2)} after diff fetch failure`,
              );
            } else if (result.toolFailed) {
              // Track per-task tool error count
              const errCount = (state.taskErrorCounts.get(task.task_id) ?? 0) + 1;
              state.taskErrorCounts.set(task.task_id, errCount);
              if (errCount >= MAX_TASK_ERROR_ATTEMPTS) {
                state.logger.logWarn(
                  `${icons.warn} Giving up on task ${task.task_id.slice(0, 8)}… after ${errCount} tool failures`,
                );
              }
              state.weight = Math.max(0, state.weight * WEIGHT_PENALTY_FACTOR);
              state.lastWeightUpdateAt = Date.now();
              state.logger.logWarn(
                `${icons.warn} Weight reduced to ${state.weight.toFixed(2)} after tool error`,
              );
            } else {
              // Successful task — recover weight
              state.weight = Math.min(1.0, state.weight + WEIGHT_RECOVERY);
              state.lastWeightUpdateAt = Date.now();
              // If we were paused and the recovery pushed us back above the
              // threshold, log "resumed" and clear the flag now so a rapid
              // re-pause isn't silently suppressed on the next poll.
              if (state.weight >= MIN_DISPATCH_WEIGHT && state.pausedLogged) {
                state.logger.log(
                  `${icons.info} Agent resumed (weight ${state.weight.toFixed(2)} ≥ ${MIN_DISPATCH_WEIGHT})`,
                );
                state.pausedLogged = false;
              }
            }
          } catch (err) {
            logError(`${icons.error} Task handler failed: ${(err as Error).message}`);
            consecutiveErrors++;
            // Track per-task error count so this agent stops retrying the same task
            const errCount = (state.taskErrorCounts.get(task.task_id) ?? 0) + 1;
            state.taskErrorCounts.set(task.task_id, errCount);
            if (errCount >= MAX_TASK_ERROR_ATTEMPTS) {
              state.logger.logWarn(
                `${icons.warn} Giving up on task ${task.task_id.slice(0, 8)}… after ${errCount} failures`,
              );
            }
            // Penalize weight on tool/task error
            state.weight = Math.max(0, state.weight * WEIGHT_PENALTY_FACTOR);
            state.lastWeightUpdateAt = Date.now();
            state.logger.logWarn(
              `${icons.warn} Weight reduced to ${state.weight.toFixed(2)} after task error`,
            );
          } finally {
            busyAgents.delete(state);
            // Sweep deferred codebase cleanups for this agent on task completion
            if (state.cleanupTracker) {
              try {
                const swept = await state.cleanupTracker.sweep(cleanupWorktree);
                if (swept > 0) {
                  state.logger.log(
                    `${icons.info} Cleaned up ${swept} stale codebase director${swept === 1 ? 'y' : 'ies'}`,
                  );
                }
              } catch {
                // cleanup is best-effort
              }
            }
          }
        })();
        inflightPromises.add(p);
        void p.finally(() => inflightPromises.delete(p));
      }
    } catch (err) {
      if (signal?.aborted) break;

      if (err instanceof UpgradeRequiredError) {
        logWarn(`${icons.warn} ${err.message}`);
        process.exitCode = 1;
        break;
      }

      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        consecutiveAuthErrors++;
        consecutiveErrors++;
        logError(
          `${icons.error} Auth error (${err.status}): ${err.message} [${consecutiveAuthErrors}/${MAX_CONSECUTIVE_AUTH_ERRORS}]`,
        );
        if (consecutiveAuthErrors >= MAX_CONSECUTIVE_AUTH_ERRORS) {
          logError(`${icons.error} Authentication failed repeatedly. Exiting.`);
          process.exitCode = 1;
          break;
        }
      } else {
        consecutiveAuthErrors = 0;
        consecutiveErrors++;
        logError(`${icons.error} Batch poll error: ${(err as Error).message}`);
      }

      if (consecutiveErrors >= maxConsecutiveErrors) {
        logError(
          `Too many consecutive errors (${consecutiveErrors}/${maxConsecutiveErrors}). Shutting down.`,
        );
        process.exitCode = 1;
        break;
      }

      if (consecutiveErrors > 0) {
        const backoff = Math.min(
          pollIntervalMs * Math.pow(2, consecutiveErrors - 1),
          MAX_POLL_BACKOFF_MS,
        );
        const extraDelay = backoff - pollIntervalMs;
        if (extraDelay > 0) {
          logWarn(
            `Batch poll failed (${consecutiveErrors} consecutive). Next poll in ${Math.round(backoff / 1000)}s`,
          );
          await sleep(extraDelay, signal);
        }
      }
    }

    await sleep(pollIntervalMs, signal);
  }

  // Wait for any in-flight tasks to complete before returning
  if (inflightPromises.size > 0) {
    log(`${icons.info} Waiting for ${inflightPromises.size} in-flight task(s) to complete...`);
    await Promise.allSettled([...inflightPromises]);
  }
}

/**
 * Start all configured agents using a single batch poll loop.
 * Replaces the N independent poll loops from `--all` mode.
 */
export async function startBatchAgents(
  config: ReturnType<typeof loadConfig>,
  agents: LocalAgentConfig[],
  pollIntervalMs: number,
  oauthToken: string,
  options: {
    versionOverride?: string | null;
    verbose?: boolean;
    instancesOverride?: number;
    agentOwner?: string;
    userOrgs?: ReadonlySet<string>;
  },
): Promise<void> {
  const { versionOverride, verbose, instancesOverride, agentOwner, userOrgs } = options;

  const client = new ApiClient(config.platformUrl, {
    authToken: oauthToken,
    cliVersion: __CLI_VERSION__,
    versionOverride,
    onTokenRefresh: () => getValidToken(config.platformUrl, { configPath: config.authFile }),
  });

  const coordLogger = createLogger('batch');
  const { log, logError, logWarn } = coordLogger;

  // Pre-flight: verify repo access
  const allRepos = extractRepoUrls(agents);
  let accessibleRepos: Set<string> | undefined;

  if (allRepos.length > 0) {
    log(`${icons.info} Verifying access to ${allRepos.length} repo(s)...`);
    const result = await verifyRepoAccess(allRepos, oauthToken);
    for (const repo of result.accessible) {
      log(`  ${icons.success} ${repo}`);
    }
    for (const repo of result.inaccessible) {
      logWarn(`  ${icons.warn} ${repo} — no access, excluded from polling`);
    }
    if (result.accessible.length === 0) {
      logError(`${icons.error} No accessible repos. Cannot start agents.`);
      process.exitCode = 1;
      return;
    }
    accessibleRepos = new Set(result.accessible);
  }

  // Build per-agent state
  const agentStates: BatchAgentState[] = [];
  let skipped = 0;

  for (let i = 0; i < agents.length; i++) {
    const agentConfig = agents[i];
    const commandTemplate = resolveCommandTemplate(agentConfig, config.agentCommand);
    const label = agentConfig.name ?? `agent[${i}]`;

    if (!commandTemplate) {
      logError(`[${label}] No command configured. Skipping.`);
      skipped++;
      continue;
    }

    if (!validateCommandBinary(commandTemplate)) {
      logError(`[${label}] Command binary not found: ${commandTemplate.split(' ')[0]}. Skipping.`);
      skipped++;
      continue;
    }

    const instanceCount = instancesOverride ?? agentConfig.instances ?? 1;
    const codebaseDir = resolveCodebaseDir(agentConfig.codebase_dir, config.codebaseDir);
    const reviewDeps: ReviewExecutorDeps = {
      commandTemplate,
      maxDiffSizeKb: config.maxDiffSizeKb,
      maxRepoSizeMb: config.maxRepoSizeMb,
      codebaseDir,
      livenessTimeoutMs:
        agentConfig.livenessTimeout != null ? agentConfig.livenessTimeout * 1000 : undefined,
    };

    // Share session stats and usage tracker across instances of the same agent config
    const session = createSessionTracker();
    const usageTracker = new UsageTracker();

    const ttlMs = config.codebaseTtl != null ? parseTtl(config.codebaseTtl) : 0;
    const cleanupTracker = ttlMs > 0 ? new CodebaseCleanupTracker(ttlMs) : undefined;

    for (let inst = 0; inst < instanceCount; inst++) {
      const agentId = crypto.randomUUID();
      const instanceLabel = instanceCount > 1 ? `${label}#${inst + 1}` : label;
      const descriptor = agentConfigToDescriptor(agentConfig, agentId, i, agentOwner, userOrgs);
      // Override name with instance-specific label
      descriptor.name = instanceLabel;

      const isRouter = agentConfig.router === true;
      let routerRelay: RouterRelay | undefined;
      if (isRouter) {
        routerRelay = new RouterRelay();
        routerRelay.start();
      }

      agentStates.push({
        descriptor,
        reviewDeps,
        consumptionDeps: {
          agentId,
          session,
          usageTracker,
          usageLimits: config.usageLimits,
          agentLimits:
            agentConfig.maxTasksPerDay !== undefined
              ? { maxTasksPerDay: agentConfig.maxTasksPerDay }
              : undefined,
        },
        logger: createLogger(instanceLabel),
        agentSession: createAgentSession(),
        routerRelay,
        cleanupTracker,
        verbose,
        diffFailCounts: new Map(),
        taskErrorCounts: new Map(),
        weight: 1.0,
        lastWeightUpdateAt: Date.now(),
        pausedLogged: false,
      });
    }
  }

  if (agentStates.length === 0) {
    logError('No agents could be started. Check your config.');
    process.exitCode = 1;
    return;
  }

  if (skipped > 0) {
    logWarn(
      `${skipped} agent config(s) skipped (see warnings above). Continuing with ${agentStates.length} instance(s).`,
    );
  }

  // Dry-run test commands for non-router agents (in parallel — they're independent)
  await Promise.all(
    agentStates
      .filter((state) => state.reviewDeps.commandTemplate && !state.routerRelay)
      .map(async (state) => {
        state.logger.log('Testing command...');
        const result = await testCommand(
          state.reviewDeps.commandTemplate!,
          config.commandTestTimeoutMs,
        );
        if (result.ok) {
          state.logger.log(
            `${icons.success} Command test ok (${(result.elapsedMs / 1000).toFixed(1)}s)`,
          );
        } else {
          state.logger.logWarn(
            `${icons.warn} Command test failed (${result.error}). Reviews may fail.`,
          );
        }
      }),
  );

  // Startup scan: remove stale worktree directories
  const codebaseDirs = new Set(
    agentStates.map((s) => s.reviewDeps.codebaseDir || path.join(CONFIG_DIR, 'repos')),
  );
  for (const dir of codebaseDirs) {
    const ttlMs = config.codebaseTtl != null ? parseTtl(config.codebaseTtl) : 0;
    const scanTtl = Math.max(ttlMs, DEFAULT_CODEBASE_TTL_MS);
    const staleCount = scanAndCleanStaleWorktrees(dir, scanTtl);
    if (staleCount > 0) {
      log(
        `${icons.info} Cleaned up ${staleCount} stale codebase director${staleCount === 1 ? 'y' : 'ies'} on startup`,
      );
    }
  }

  const abortController = new AbortController();
  const removeShutdownHandlers = registerShutdownHandlers(abortController, log);

  log(`${agentStates.length} agent instance(s) running in batch mode. Press Ctrl+C to stop.\n`);

  try {
    await batchPollLoop(client, agentStates, {
      pollIntervalMs,
      maxConsecutiveErrors: config.maxConsecutiveErrors,
      signal: abortController.signal,
      accessibleRepos,
      githubToken: oauthToken,
    });

    // Cleanup on shutdown (in parallel, allSettled so one failure doesn't hide others)
    await Promise.allSettled(
      agentStates.map(async (state) => {
        state.routerRelay?.stop();
        if (state.cleanupTracker && state.cleanupTracker.size > 0) {
          const swept = await state.cleanupTracker.sweep(cleanupWorktree);
          if (swept > 0) {
            state.logger.log(
              `${icons.info} Cleaned up ${swept} codebase director${swept === 1 ? 'y' : 'ies'} on shutdown`,
            );
          }
        }
        if (state.consumptionDeps.usageTracker) {
          const limits = state.consumptionDeps.usageLimits ?? {
            maxTasksPerDay: null,
            maxTokensPerDay: null,
            maxTokensPerReview: null,
          };
          state.logger.log(
            state.consumptionDeps.usageTracker.formatSummary(
              limits,
              state.consumptionDeps.agentLimits,
              state.consumptionDeps.agentId,
            ),
          );
        }
        state.logger.log(formatExitSummary(state.agentSession));
      }),
    );
  } finally {
    removeShutdownHandlers();
  }
}

/**
 * Start agent in router mode (stdin/stdout relay).
 * Default action when running `opencara` with no subcommand.
 */
export async function startAgentRouter(): Promise<void> {
  const config = loadConfig();
  const agentId = crypto.randomUUID();

  // Build agent config from the first local agent or defaults
  let agentConfig: LocalAgentConfig | undefined;

  if (config.agents && config.agents.length > 0) {
    agentConfig = config.agents.find((a) => a.router) ?? config.agents[0];
  }
  const commandTemplate = resolveCommandTemplate(agentConfig, config.agentCommand);

  const router = new RouterRelay();
  router.start();

  const logger = createLogger(agentConfig?.name ?? 'agent[0]');

  // Authenticate via OAuth (auto-triggers login if not authenticated)
  let oauthToken: string;
  try {
    oauthToken = await ensureAuth(config.platformUrl, { configPath: config.authFile });
  } catch (err) {
    if (err instanceof AuthError) {
      logger.logError(`${icons.error} ${err.message}`);
      router.stop();
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const storedAuth = loadAuth(config.authFile);
  const agentOwner = storedAuth?.github_username;
  if (storedAuth) {
    logger.log(`Authenticated as ${storedAuth.github_username}`);
  }

  // Fetch org memberships only when private mode needs them
  const repoConfig = agentConfig?.repos;
  const userOrgs =
    repoConfig?.mode === 'private' ? await fetchUserOrgs(oauthToken) : new Set<string>();

  const codebaseDir = resolveCodebaseDir(agentConfig?.codebase_dir, config.codebaseDir);
  const reviewDeps: ReviewExecutorDeps = {
    commandTemplate: commandTemplate ?? '',
    maxDiffSizeKb: config.maxDiffSizeKb,
    maxRepoSizeMb: config.maxRepoSizeMb,
    codebaseDir,
    livenessTimeoutMs:
      agentConfig?.livenessTimeout != null ? agentConfig.livenessTimeout * 1000 : undefined,
  };

  const session = createSessionTracker();
  const usageTracker = new UsageTracker();

  const model = agentConfig?.model ?? 'unknown';
  const tool = agentConfig?.tool ?? 'unknown';
  const thinking = agentConfig?.thinking;
  const label = agentConfig?.name ?? 'agent[0]';
  const roles = agentConfig ? computeRoles(agentConfig) : undefined;
  // Router mode supports version override via env var only (no CLI flag in default mode)
  const versionOverride = process.env.OPENCARA_VERSION_OVERRIDE || null;

  await startAgent(
    agentId,
    config.platformUrl,
    { model, tool, thinking },
    reviewDeps,
    {
      agentId,
      session,
      usageTracker,
      usageLimits: config.usageLimits,
      agentLimits:
        agentConfig?.maxTasksPerDay !== undefined
          ? { maxTasksPerDay: agentConfig.maxTasksPerDay }
          : undefined,
    },
    {
      maxConsecutiveErrors: config.maxConsecutiveErrors,
      routerRelay: router,
      reviewOnly: agentConfig?.review_only,
      repoConfig,
      roles,
      synthesizeRepos: agentConfig?.synthesize_repos,
      label,
      authToken: oauthToken,
      onTokenRefresh: () => getValidToken(config.platformUrl, { configPath: config.authFile }),
      agentOwner,
      userOrgs,
      usageLimits: config.usageLimits,
      versionOverride,
      codebaseTtl: config.codebaseTtl,
      commandTestTimeoutMs: config.commandTestTimeoutMs,
    },
  );

  router.stop();
}

// ── CLI Commands ─────────────────────────────────────────────

/**
 * Resolve and start a single agent by index from config.
 * Returns a promise that resolves when the agent stops.
 * Returns null (with error logged) if the agent cannot be started.
 *
 * @param oauthToken — pre-resolved OAuth token from auth.ts.
 */
function startAgentByIndex(
  config: ReturnType<typeof loadConfig>,
  agentIndex: number,
  pollIntervalMs: number,
  oauthToken: string,
  versionOverride?: string | null,
  verbose?: boolean,
  instancesOverride?: number,
  agentOwner?: string,
  userOrgs?: ReadonlySet<string>,
): Promise<void>[] | null {
  let agentConfig: LocalAgentConfig | undefined;

  if (config.agents && config.agents.length > agentIndex) {
    agentConfig = config.agents[agentIndex];
  }
  const commandTemplate = resolveCommandTemplate(agentConfig, config.agentCommand);

  const label = agentConfig?.name ?? `agent[${agentIndex}]`;

  if (!commandTemplate) {
    console.error(`[${label}] No command configured. Skipping.`);
    return null;
  }

  if (!validateCommandBinary(commandTemplate)) {
    console.error(
      `[${label}] Command binary not found: ${commandTemplate.split(' ')[0]}. Skipping.`,
    );
    return null;
  }

  const instanceCount = instancesOverride ?? agentConfig?.instances ?? 1;

  const codebaseDir = resolveCodebaseDir(agentConfig?.codebase_dir, config.codebaseDir);
  const reviewDeps: ReviewExecutorDeps = {
    commandTemplate,
    maxDiffSizeKb: config.maxDiffSizeKb,
    maxRepoSizeMb: config.maxRepoSizeMb,
    codebaseDir,
    livenessTimeoutMs:
      agentConfig?.livenessTimeout != null ? agentConfig.livenessTimeout * 1000 : undefined,
  };

  const model = agentConfig?.model ?? 'unknown';
  const tool = agentConfig?.tool ?? 'unknown';
  const thinking = agentConfig?.thinking;
  const roles = agentConfig ? computeRoles(agentConfig) : undefined;

  // Share session stats and usage tracker across all instances so limits are
  // enforced on the aggregate, not per-instance.
  const session = createSessionTracker();
  const usageTracker = new UsageTracker();

  const promises: Promise<void>[] = [];
  for (let inst = 0; inst < instanceCount; inst++) {
    const agentId = crypto.randomUUID();
    const instanceLabel = instanceCount > 1 ? `${label}#${inst + 1}` : label;

    const isRouter = agentConfig?.router === true;
    let routerRelay: RouterRelay | undefined;
    if (isRouter) {
      routerRelay = new RouterRelay();
      routerRelay.start();
    }

    const agentPromise = startAgent(
      agentId,
      config.platformUrl,
      { model, tool, thinking },
      reviewDeps,
      {
        agentId,
        session,
        usageTracker,
        usageLimits: config.usageLimits,
        agentLimits:
          agentConfig?.maxTasksPerDay !== undefined
            ? { maxTasksPerDay: agentConfig.maxTasksPerDay }
            : undefined,
      },
      {
        pollIntervalMs,
        maxConsecutiveErrors: config.maxConsecutiveErrors,
        routerRelay,
        reviewOnly: agentConfig?.review_only,
        repoConfig: agentConfig?.repos,
        roles,
        synthesizeRepos: agentConfig?.synthesize_repos,
        label: instanceLabel,
        authToken: oauthToken,
        onTokenRefresh: () => getValidToken(config.platformUrl, { configPath: config.authFile }),
        usageLimits: config.usageLimits,
        versionOverride,
        codebaseTtl: config.codebaseTtl,
        verbose,
        agentOwner,
        userOrgs,
        commandTestTimeoutMs: config.commandTestTimeoutMs,
      },
    ).finally(() => {
      routerRelay?.stop();
    });

    promises.push(agentPromise);
  }

  return promises;
}

export const agentCommand = new Command('agent').description('Manage review agents');

agentCommand
  .command('start')
  .description('Start agents in polling mode')
  .option('--poll-interval <seconds>', 'Poll interval in seconds', '10')
  .option('--agent <index>', 'Start a single agent by index from config.toml (0-based)')
  .option('--all', 'Start all configured agents concurrently (default when --agent is not set)')
  .option(
    '--version-override <value>',
    'Cloudflare Workers version override (e.g. opencara-server=abc123)',
  )
  .option('-v, --verbose', 'Log tool stdout/stderr after each review/summary for debugging')
  .option('--instances <count>', 'Number of concurrent instances per agent (overrides config)')
  .action(
    async (opts: {
      pollInterval: string;
      agent?: string;
      all?: boolean;
      versionOverride?: string;
      verbose?: boolean;
      instances?: string;
    }) => {
      let config = loadConfig();

      // First-run interactive setup: trigger only when no config file exists AND stdin is TTY
      if (!config.agents && !fs.existsSync(CONFIG_FILE)) {
        const created = await interactiveSetup();
        if (!created) {
          if (!process.stdin.isTTY) {
            console.error(`No config found at ${CONFIG_FILE}`);
            console.error('Create a config file or run interactively to use first-run setup.');
          }
          process.exit(1);
          return;
        }
        config = loadConfig();
      }

      // Print startup banner
      console.log(formatVersionBanner(__CLI_VERSION__, __GIT_COMMIT__));

      // Display agent tools with their enabled roles
      if (config.agents && config.agents.length > 0) {
        const toolEntries = config.agents.map((a) => ({
          tool: a.tool,
          name: a.name,
          roles: computeRoles(a),
        }));
        console.log('Agent tools:');
        for (const line of formatAgentTools(toolEntries)) {
          console.log(line);
        }
      }

      const pollIntervalMs = parseInt(opts.pollInterval, 10) * 1000;
      const versionOverride = opts.versionOverride || process.env.OPENCARA_VERSION_OVERRIDE || null;
      let instancesOverride: number | undefined;
      if (opts.instances !== undefined) {
        if (!/^[1-9]\d*$/.test(opts.instances)) {
          console.error('--instances must be a positive integer');
          process.exit(1);
          return;
        }
        instancesOverride = parseInt(opts.instances, 10);
      }

      // Authenticate via OAuth (auto-triggers login if not authenticated)
      let oauthToken: string;
      try {
        oauthToken = await ensureAuth(config.platformUrl, { configPath: config.authFile });
      } catch (err) {
        if (err instanceof AuthError) {
          console.error(err.message);
          process.exit(1);
          return;
        }
        throw err;
      }

      const storedAuth = loadAuth(config.authFile);
      const agentOwner = storedAuth?.github_username;
      if (storedAuth) {
        console.log(`Authenticated as ${storedAuth.github_username}`);
      }

      // Fetch org memberships only when at least one agent uses private mode
      const needsOrgs = config.agents?.some((a) => a.repos?.mode === 'private') ?? false;
      let userOrgs = needsOrgs
        ? await fetchUserOrgs(oauthToken, fetch, agentOwner)
        : new Set<string>();
      // Heuristic fallback: extract org names from agents' repo lists so private
      // mode works even when the GitHub API is unreachable. This is best-effort —
      // it assumes repo owners in the config are orgs the user belongs to, which
      // may not always be true (e.g., collaborator access without org membership).
      if (needsOrgs && userOrgs.size === 0 && config.agents) {
        const currentLogin = agentOwner?.toLowerCase();
        const fallbackOrgs = new Set<string>();
        for (const a of config.agents) {
          if (a.repos?.list) {
            for (const repo of a.repos.list) {
              const owner = repo.split('/')[0]?.toLowerCase();
              if (owner && owner !== currentLogin) fallbackOrgs.add(owner);
            }
          }
          if (a.synthesize_repos?.list) {
            for (const repo of a.synthesize_repos.list) {
              const owner = repo.split('/')[0]?.toLowerCase();
              if (owner && owner !== currentLogin) fallbackOrgs.add(owner);
            }
          }
        }
        if (fallbackOrgs.size > 0) {
          userOrgs = fallbackOrgs;
          console.log(`Org memberships (from config): ${[...userOrgs].join(', ')}`);
        } else {
          console.warn(
            '⚠ Failed to fetch org memberships — private mode agents may not see org repos',
          );
        }
      } else if (needsOrgs && userOrgs.size > 0) {
        console.log(`Org memberships: ${[...userOrgs].join(', ')}`);
      }

      if (opts.agent != null) {
        // Start a single agent by index (explicit --agent flag)
        const maxIndex = (config.agents?.length ?? 0) - 1;
        const agentIndex = Number(opts.agent);
        if (!Number.isInteger(agentIndex) || agentIndex < 0 || agentIndex > maxIndex) {
          console.error(
            maxIndex >= 0
              ? `--agent must be an integer between 0 and ${maxIndex}.`
              : 'No agents configured in ~/.opencara/config.toml',
          );
          process.exit(1);
          return;
        }
        const agentPromises = startAgentByIndex(
          config,
          agentIndex,
          pollIntervalMs,
          oauthToken,
          versionOverride,
          opts.verbose,
          instancesOverride,
          agentOwner,
          userOrgs,
        );
        if (!agentPromises) {
          // startAgentByIndex already logged the specific reason
          process.exit(1);
          return;
        }
        const results = await Promise.allSettled(agentPromises);
        const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failures.length > 0) {
          for (const f of failures) {
            console.error(`Agent instance failed: ${f.reason}`);
          }
          process.exit(1);
        }
      } else {
        // Default: start all agents using single batch poll coordinator
        if (!config.agents || config.agents.length === 0) {
          console.error('No agents configured in ~/.opencara/config.toml');
          process.exit(1);
          return;
        }

        console.log(`Starting ${config.agents.length} agent config(s) in batch mode...`);

        await startBatchAgents(config, config.agents, pollIntervalMs, oauthToken, {
          versionOverride,
          verbose: opts.verbose,
          instancesOverride,
          agentOwner,
          userOrgs,
        });
      }
    },
  );
