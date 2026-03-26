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
} from '@opencara/shared';
import { isRepoAllowed } from '@opencara/shared';
import {
  loadConfig,
  resolveCodebaseDir,
  DEFAULT_MAX_CONSECUTIVE_ERRORS,
  CONFIG_DIR,
  type LocalAgentConfig,
  type UsageLimits,
} from '../config.js';
import { cloneOrUpdate, cleanupTaskDir, validatePathSegment } from '../codebase.js';
import { getValidToken, loadAuth, AuthError } from '../auth.js';
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
import { fetchPRContext, formatPRContext, hasContent } from '../pr-context.js';
import {
  createLogger,
  createAgentSession,
  formatExitSummary,
  icons,
  type Logger,
  type AgentSessionStats,
} from '../logger.js';

declare const __CLI_VERSION__: string;

export interface ConsumptionDeps {
  agentId: string;
  session: SessionStats;
  usageTracker?: UsageTracker;
  usageLimits?: UsageLimits;
}

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const MAX_CONSECUTIVE_AUTH_ERRORS = 3;
const MAX_POLL_BACKOFF_MS = 300_000; // 5 minutes

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
        (err, stdout) => {
          if (err) reject(err);
          else resolve(stdout);
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
    return null;
  }
}

/**
 * Compute the roles this agent is willing to take based on its config.
 */
export function computeRoles(agent: LocalAgentConfig): TaskRole[] {
  if (agent.review_only) return ['review'];
  if (agent.synthesizer_only) return ['summary'];
  return ['review', 'summary'];
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
      const limitStatus = consumptionDeps.usageTracker.checkLimits(consumptionDeps.usageLimits);
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

      // Filter tasks by repo config, then find first not exhausted by diff fetch failures
      const eligibleTasks = repoConfig
        ? pollResponse.tasks.filter((t) => isRepoAllowed(repoConfig, t.owner, t.repo))
        : pollResponse.tasks;
      const task = eligibleTasks.find(
        (t) => (diffFailCounts.get(t.task_id) ?? 0) < MAX_DIFF_FETCH_ATTEMPTS,
      );

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
): Promise<HandleTaskResult> {
  const { task_id, owner, repo, pr_number, diff_url, timeout_seconds, prompt, role } = task;
  const { log, logError, logWarn } = logger;

  log(`${icons.success} Claimed task ${task_id} (${role}) — ${owner}/${repo}#${pr_number}`);
  log(`  https://github.com/${owner}/${repo}/pull/${pr_number}`);

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

  // Fetch diff — gh CLI first, fall back to HTTP
  let diffContent: string;
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

  // Clone/update codebase if configured, otherwise create a repo-scoped working directory
  let taskReviewDeps = reviewDeps;
  let taskCheckoutPath: string | null = null;
  if (reviewDeps.codebaseDir) {
    try {
      const result = cloneOrUpdate(owner, repo, pr_number, reviewDeps.codebaseDir, task_id);
      log(`  Codebase ${result.cloned ? 'cloned' : 'updated'}: ${result.localPath}`);
      taskCheckoutPath = result.localPath;
      // Pass the resolved local path as codebaseDir for this task
      taskReviewDeps = { ...reviewDeps, codebaseDir: result.localPath };
    } catch (err) {
      logWarn(
        `  Warning: codebase clone failed: ${(err as Error).message}. Continuing with diff-only review.`,
      );
      taskReviewDeps = { ...reviewDeps, codebaseDir: null };
    }
  } else {
    // No codebase_dir configured — create a repo-scoped working directory
    try {
      validatePathSegment(owner, 'owner');
      validatePathSegment(repo, 'repo');
      validatePathSegment(task_id, 'task_id');
      const repoScopedDir = path.join(CONFIG_DIR, 'repos', owner, repo, task_id);
      fs.mkdirSync(repoScopedDir, { recursive: true });
      taskCheckoutPath = repoScopedDir;
      taskReviewDeps = { ...reviewDeps, codebaseDir: repoScopedDir };
      log(`  Working directory: ${repoScopedDir}`);
    } catch (err) {
      logWarn(
        `  Warning: failed to create working directory: ${(err as Error).message}. Continuing without scoped cwd.`,
      );
    }
  }

  // Fetch PR context (metadata, comments, reviews) — non-blocking on failure
  let contextBlock: string | undefined;
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

  // Execute review or summary
  try {
    if (role === 'summary' && 'reviews' in claimResponse && claimResponse.reviews) {
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
      );
    }
    agentSession.tasksCompleted++;
  } catch (err) {
    agentSession.errorsEncountered++;
    if (err instanceof DiffTooLargeError || err instanceof InputTooLargeError) {
      logError(`  ${icons.error} ${err.message}`);
      await safeReject(client, task_id, agentId, err.message, logger);
    } else {
      logError(`  ${icons.error} Error on task ${task_id}: ${(err as Error).message}`);
      await safeError(client, task_id, agentId, (err as Error).message, logger);
    }
  } finally {
    // Clean up task-specific checkout to avoid disk bloat
    if (taskCheckoutPath) {
      cleanupTaskDir(taskCheckoutPath);
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
    consumptionDeps.usageTracker.recordReview({
      input: usageOpts.inputTokens,
      output: usageOpts.outputTokens,
      estimated: usageOpts.estimated,
    });
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
      consumptionDeps.usageTracker.recordReview({
        input: usageOpts.inputTokens,
        output: usageOpts.outputTokens,
        estimated: usageOpts.estimated,
      });
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
    consumptionDeps.usageTracker.recordReview({
      input: usageOpts.inputTokens,
      output: usageOpts.outputTokens,
      estimated: usageOpts.estimated,
    });
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
    maxReviewsPerDay: null,
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

  if (!reviewDeps) {
    logError(`${icons.error} No review command configured. Set command in config.toml`);
    return;
  }

  // Dry-run test: verify command works before entering poll loop.
  // Skip in router mode (stdin/stdout relay) since there's no local command to test.
  if (reviewDeps.commandTemplate && !options?.routerRelay) {
    log('Testing command...');
    const result = await testCommand(reviewDeps.commandTemplate);
    if (result.ok) {
      log(`${icons.success} Command test ok (${(result.elapsedMs / 1000).toFixed(1)}s)`);
    } else {
      logWarn(`${icons.warn} Command test failed (${result.error}). Reviews may fail.`);
    }
  }

  const abortController = new AbortController();

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    abortController.abort();
  });
  process.on('SIGTERM', () => {
    abortController.abort();
  });

  await pollLoop(client, agentId, reviewDeps, deps, agentInfo, logger, agentSession, {
    pollIntervalMs: options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxConsecutiveErrors: options?.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS,
    routerRelay: options?.routerRelay,
    reviewOnly: options?.reviewOnly,
    repoConfig: options?.repoConfig,
    roles: options?.roles,
    synthesizeRepos: options?.synthesizeRepos,
    signal: abortController.signal,
  });

  // Print usage summary on shutdown
  if (deps.usageTracker) {
    log(deps.usageTracker.formatSummary(deps.usageLimits ?? usageLimits));
  }
  log(formatExitSummary(agentSession));
}

/**
 * Start agent in router mode (stdin/stdout relay).
 * Default action when running `opencara` with no subcommand.
 */
export async function startAgentRouter(): Promise<void> {
  const config = loadConfig();
  const agentId = crypto.randomUUID();

  // Build agent config from the first local agent or defaults
  let commandTemplate: string | undefined;
  let agentConfig: LocalAgentConfig | undefined;

  if (config.agents && config.agents.length > 0) {
    agentConfig = config.agents.find((a) => a.router) ?? config.agents[0];
    commandTemplate = agentConfig.command ?? config.agentCommand ?? undefined;
  } else {
    commandTemplate = config.agentCommand ?? undefined;
  }

  const router = new RouterRelay();
  router.start();

  const logger = createLogger(agentConfig?.name ?? 'agent[0]');

  // Authenticate via OAuth
  let oauthToken: string;
  try {
    oauthToken = await getValidToken(config.platformUrl);
  } catch (err) {
    if (err instanceof AuthError) {
      logger.logError(`${icons.error} ${err.message}`);
      router.stop();
      process.exitCode = 1;
      return;
    }
    throw err;
  }

  const storedAuth = loadAuth();
  if (storedAuth) {
    logger.log(`Authenticated as ${storedAuth.github_username}`);
  }

  const codebaseDir = resolveCodebaseDir(agentConfig?.codebase_dir, config.codebaseDir);
  const reviewDeps: ReviewExecutorDeps = {
    commandTemplate: commandTemplate ?? '',
    maxDiffSizeKb: config.maxDiffSizeKb,
    codebaseDir,
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
    },
    {
      maxConsecutiveErrors: config.maxConsecutiveErrors,
      routerRelay: router,
      reviewOnly: agentConfig?.review_only,
      repoConfig: agentConfig?.repos,
      roles,
      synthesizeRepos: agentConfig?.synthesize_repos,
      label,
      authToken: oauthToken,
      onTokenRefresh: () => getValidToken(config.platformUrl),
      usageLimits: config.usageLimits,
      versionOverride,
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
): Promise<void> | null {
  const agentId = crypto.randomUUID();
  let commandTemplate: string | undefined;
  let agentConfig: LocalAgentConfig | undefined;

  if (config.agents && config.agents.length > agentIndex) {
    agentConfig = config.agents[agentIndex];
    commandTemplate = agentConfig.command ?? config.agentCommand ?? undefined;
  } else {
    commandTemplate = config.agentCommand ?? undefined;
  }

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

  const codebaseDir = resolveCodebaseDir(agentConfig?.codebase_dir, config.codebaseDir);
  const reviewDeps: ReviewExecutorDeps = {
    commandTemplate,
    maxDiffSizeKb: config.maxDiffSizeKb,
    codebaseDir,
  };

  const isRouter = agentConfig?.router === true;
  let routerRelay: RouterRelay | undefined;
  if (isRouter) {
    routerRelay = new RouterRelay();
    routerRelay.start();
  }

  const session = createSessionTracker();
  const usageTracker = new UsageTracker();
  const model = agentConfig?.model ?? 'unknown';
  const tool = agentConfig?.tool ?? 'unknown';
  const thinking = agentConfig?.thinking;
  const roles = agentConfig ? computeRoles(agentConfig) : undefined;

  const agentPromise = startAgent(
    agentId,
    config.platformUrl,
    { model, tool, thinking },
    reviewDeps,
    { agentId, session, usageTracker, usageLimits: config.usageLimits },
    {
      pollIntervalMs,
      maxConsecutiveErrors: config.maxConsecutiveErrors,
      routerRelay,
      reviewOnly: agentConfig?.review_only,
      repoConfig: agentConfig?.repos,
      roles,
      synthesizeRepos: agentConfig?.synthesize_repos,
      label,
      authToken: oauthToken,
      onTokenRefresh: () => getValidToken(config.platformUrl),
      usageLimits: config.usageLimits,
      versionOverride,
    },
  ).finally(() => {
    routerRelay?.stop();
  });

  return agentPromise;
}

export const agentCommand = new Command('agent').description('Manage review agents');

agentCommand
  .command('start')
  .description('Start agents in polling mode')
  .option('--poll-interval <seconds>', 'Poll interval in seconds', '10')
  .option('--agent <index>', 'Agent index from config.toml (0-based)', '0')
  .option('--all', 'Start all configured agents concurrently')
  .option(
    '--version-override <value>',
    'Cloudflare Workers version override (e.g. opencara-server=abc123)',
  )
  .action(
    async (opts: {
      pollInterval: string;
      agent: string;
      all?: boolean;
      versionOverride?: string;
    }) => {
      const config = loadConfig();
      const pollIntervalMs = parseInt(opts.pollInterval, 10) * 1000;
      const versionOverride = opts.versionOverride || process.env.OPENCARA_VERSION_OVERRIDE || null;

      // Authenticate via OAuth
      let oauthToken: string;
      try {
        oauthToken = await getValidToken(config.platformUrl);
      } catch (err) {
        if (err instanceof AuthError) {
          console.error(err.message);
          process.exit(1);
          return;
        }
        throw err;
      }

      const storedAuth = loadAuth();
      if (storedAuth) {
        console.log(`Authenticated as ${storedAuth.github_username}`);
      }

      if (opts.all) {
        // Start all agents concurrently
        if (!config.agents || config.agents.length === 0) {
          console.error('No agents configured in ~/.opencara/config.toml');
          process.exit(1);
          return;
        }

        console.log(`Starting ${config.agents.length} agent(s)...`);

        const promises: Promise<void>[] = [];
        let startFailed = false;
        for (let i = 0; i < config.agents.length; i++) {
          const p = startAgentByIndex(config, i, pollIntervalMs, oauthToken, versionOverride);
          if (p) {
            promises.push(p);
          } else {
            startFailed = true;
          }
        }

        if (promises.length === 0) {
          console.error('No agents could be started. Check your config.');
          process.exit(1);
          return;
        }

        if (startFailed) {
          console.error(
            'One or more agents could not start (see warnings above). Continuing with the rest.',
          );
        }

        console.log(`${promises.length} agent(s) running. Press Ctrl+C to stop all.\n`);

        // Use allSettled so one agent crashing doesn't orphan the others
        const results = await Promise.allSettled(promises);
        const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
        if (failures.length > 0) {
          for (const f of failures) {
            console.error(`Agent exited with error: ${f.reason}`);
          }
          process.exit(1);
        }
      } else {
        // Start a single agent by index
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
        const p = startAgentByIndex(
          config,
          agentIndex,
          pollIntervalMs,
          oauthToken,
          versionOverride,
        );
        if (!p) {
          // startAgentByIndex already logged the specific reason
          process.exit(1);
          return;
        }
        await p;
      }
    },
  );
