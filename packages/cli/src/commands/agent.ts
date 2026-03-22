import { Command } from 'commander';
import crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  PollResponse,
  PollTask,
  ClaimResponse,
  ClaimReview,
  ReviewVerdict,
  ClaimRole,
  RepoConfig,
} from '@opencara/shared';
import { isRepoAllowed } from '@opencara/shared';
import {
  loadConfig,
  resolveCodebaseDir,
  resolveGithubToken as resolveConfigToken,
  DEFAULT_MAX_CONSECUTIVE_ERRORS,
  CONFIG_DIR,
  type LocalAgentConfig,
} from '../config.js';
import { cloneOrUpdate, cleanupTaskDir, validatePathSegment } from '../codebase.js';
import { resolveGithubToken, logAuthMethod, type GithubAuthResult } from '../github-auth.js';
import { ApiClient, HttpError } from '../http.js';
import { withRetry, NonRetryableError } from '../retry.js';
import { executeReview, DiffTooLargeError, type ReviewExecutorDeps } from '../review.js';
import { executeSummary, InputTooLargeError } from '../summary.js';
import { validateCommandBinary, estimateTokens, testCommand } from '../tool-executor.js';
import { RouterRelay } from '../router.js';
import {
  createSessionTracker,
  recordSessionUsage,
  formatPostReviewStats,
  type SessionStats,
} from '../consumption.js';
import { sanitizeTokens } from '../sanitize.js';
import { fetchPRContext, formatPRContext, hasContent } from '../pr-context.js';

export interface ConsumptionDeps {
  agentId: string;
  session: SessionStats;
}

const DEFAULT_POLL_INTERVAL_MS = 10_000;
const MAX_CONSECUTIVE_AUTH_ERRORS = 3;
const MAX_POLL_BACKOFF_MS = 300_000; // 5 minutes

/** Logger functions that optionally prepend a label prefix. */
interface Logger {
  log: (msg: string) => void;
  logError: (msg: string) => void;
  logWarn: (msg: string) => void;
}

function createLogger(label?: string): Logger {
  const prefix = label ? `[${label}] ` : '';
  return {
    log: (msg: string) => console.log(`${prefix}${sanitizeTokens(msg)}`),
    logError: (msg: string) => console.error(`${prefix}${sanitizeTokens(msg)}`),
    logWarn: (msg: string) => console.warn(`${prefix}${sanitizeTokens(msg)}`),
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
 * Fetch the PR diff directly from GitHub.
 * Agent fetches diff itself — server never sends it.
 *
 * When githubToken is provided, uses the GitHub API with Accept header
 * (required for private repos — web URLs don't accept OAuth tokens).
 * Falls back to the web .diff URL for unauthenticated public repo access.
 */
async function fetchDiff(
  diffUrl: string,
  githubToken?: string | null,
  signal?: AbortSignal,
): Promise<string> {
  return withRetry(
    async () => {
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

      const response = await fetch(url, { headers, signal });
      if (!response.ok) {
        const msg = `Failed to fetch diff: ${response.status} ${response.statusText}`;
        if (NON_RETRYABLE_STATUSES.has(response.status)) {
          const hint =
            response.status === 404
              ? '. If this is a private repo, configure github_token in ~/.opencara/config.yml'
              : '';
          throw new NonRetryableError(`${msg}${hint}`);
        }
        throw new Error(msg);
      }
      return response.text();
    },
    { maxAttempts: 2 },
    signal,
  );
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
  agentInfo: { model: string; tool: string },
  logger: Logger,
  options: {
    pollIntervalMs: number;
    maxConsecutiveErrors: number;
    routerRelay?: RouterRelay;
    reviewOnly?: boolean;
    repoConfig?: RepoConfig;
    signal?: AbortSignal;
  },
): Promise<void> {
  const { pollIntervalMs, maxConsecutiveErrors, routerRelay, reviewOnly, repoConfig, signal } =
    options;
  const { log, logError, logWarn } = logger;

  log(`Agent ${agentId} polling every ${pollIntervalMs / 1000}s...`);

  let consecutiveAuthErrors = 0;
  let consecutiveErrors = 0;
  /** Tasks that repeatedly failed diff fetch — skip on future polls. */
  const diffFailCounts = new Map<string, number>();

  while (!signal?.aborted) {
    try {
      // Poll for tasks
      const pollBody: Record<string, unknown> = { agent_id: agentId };
      if (reviewOnly) pollBody.review_only = true;
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
          routerRelay,
          signal,
        );
        if (result.diffFetchFailed) {
          const count = (diffFailCounts.get(task.task_id) ?? 0) + 1;
          diffFailCounts.set(task.task_id, count);
          if (count >= MAX_DIFF_FETCH_ATTEMPTS) {
            logWarn(`  Skipping task ${task.task_id} after ${count} diff fetch failures`);
          }
        }
      }
    } catch (err) {
      if (signal?.aborted) break;

      if (err instanceof HttpError && (err.status === 401 || err.status === 403)) {
        consecutiveAuthErrors++;
        consecutiveErrors++;
        logError(
          `Auth error (${err.status}): ${err.message} [${consecutiveAuthErrors}/${MAX_CONSECUTIVE_AUTH_ERRORS}]`,
        );
        if (consecutiveAuthErrors >= MAX_CONSECUTIVE_AUTH_ERRORS) {
          logError('Authentication failed repeatedly. Exiting.');
          break;
        }
      } else {
        consecutiveAuthErrors = 0;
        consecutiveErrors++;
        logError(`Poll error: ${(err as Error).message}`);
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
  agentInfo: { model: string; tool: string },
  logger: Logger,
  routerRelay?: RouterRelay,
  signal?: AbortSignal,
): Promise<HandleTaskResult> {
  const { task_id, owner, repo, pr_number, diff_url, timeout_seconds, prompt, role } = task;
  const { log, logError, logWarn } = logger;

  log(`\nTask ${task_id}: PR #${pr_number} on ${owner}/${repo} (role: ${role})`);
  log(`  https://github.com/${owner}/${repo}/pull/${pr_number}`);

  // Claim the task (retry once — slot may be taken)
  let claimResponse: ClaimResponse;
  try {
    claimResponse = await withRetry(
      () =>
        client.post<ClaimResponse>(`/api/tasks/${task_id}/claim`, {
          agent_id: agentId,
          role,
          model: agentInfo.model,
          tool: agentInfo.tool,
        }),
      { maxAttempts: 2 },
      signal,
    );
  } catch (err) {
    const status = err instanceof HttpError ? ` (${err.status})` : '';
    logError(`  Failed to claim task ${task_id}${status}: ${(err as Error).message}`);
    return {};
  }

  if (!claimResponse.claimed) {
    log(`  Claim rejected: ${(claimResponse as { reason: string }).reason}`);
    return {};
  }

  log(`  Claimed as ${role}`);

  // Fetch diff (retry up to 2 times via fetchDiff)
  let diffContent: string;
  try {
    diffContent = await fetchDiff(diff_url, reviewDeps.githubToken, signal);
    log(`  Diff fetched (${Math.round(diffContent.length / 1024)}KB)`);
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
      const result = cloneOrUpdate(
        owner,
        repo,
        pr_number,
        reviewDeps.codebaseDir,
        reviewDeps.githubToken,
        task_id,
      );
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
      githubToken: reviewDeps.githubToken,
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
        routerRelay,
        signal,
        contextBlock,
      );
    }
  } catch (err) {
    if (err instanceof DiffTooLargeError || err instanceof InputTooLargeError) {
      logError(`  ${err.message}`);
      await safeReject(client, task_id, agentId, err.message, logger);
    } else {
      logError(`  Error on task ${task_id}: ${(err as Error).message}`);
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
  routerRelay?: RouterRelay,
  signal?: AbortSignal,
  contextBlock?: string,
): Promise<void> {
  let reviewText: string;
  let verdict: ReviewVerdict;
  let tokensUsed: number;

  if (routerRelay) {
    // Router mode: relay to external agent
    logger.log(`  Executing review command: [router mode]`);
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
  } else {
    // Direct mode: execute tool locally
    logger.log(`  Executing review command: ${reviewDeps.commandTemplate}`);
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
  }

  // Sanitize review text before submission to prevent token leakage
  const sanitizedReview = sanitizeTokens(reviewText);

  // Submit result — retry up to 3 times (highest-risk operation)
  await withRetry(
    () =>
      client.post(`/api/tasks/${taskId}/result`, {
        agent_id: agentId,
        type: 'review' as ClaimRole,
        review_text: sanitizedReview,
        verdict,
        tokens_used: tokensUsed,
      }),
    { maxAttempts: 3 },
    signal,
  );

  recordSessionUsage(consumptionDeps.session, tokensUsed);
  logger.log(`  Review submitted (${tokensUsed.toLocaleString()} tokens)`);
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
  routerRelay?: RouterRelay,
  signal?: AbortSignal,
  contextBlock?: string,
): Promise<void> {
  if (reviews.length === 0) {
    // Single-agent mode (review_count=1): this IS the review, run it as a regular
    // review but submit as 'summary' to match the claimed role.
    let reviewText: string;
    let verdict: ReviewVerdict | undefined;
    let tokensUsed: number;

    if (routerRelay) {
      logger.log(`  Executing summary command: [router mode]`);
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
    } else {
      logger.log(`  Executing summary command: ${reviewDeps.commandTemplate}`);
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
    }

    const sanitizedReview = sanitizeTokens(reviewText);

    await withRetry(
      () =>
        client.post(`/api/tasks/${taskId}/result`, {
          agent_id: agentId,
          type: 'summary' as ClaimRole,
          review_text: sanitizedReview,
          verdict,
          tokens_used: tokensUsed,
        }),
      { maxAttempts: 3 },
      signal,
    );

    recordSessionUsage(consumptionDeps.session, tokensUsed);
    logger.log(`  Review submitted as summary (${tokensUsed.toLocaleString()} tokens)`);
    logger.log(formatPostReviewStats(consumptionDeps.session));
    return;
  }

  const summaryReviews = reviews.map((r) => ({
    agentId: r.agent_id,
    model: 'unknown',
    tool: 'unknown',
    review: r.review_text,
    verdict: r.verdict as string,
  }));

  let summaryText: string;
  let tokensUsed: number;

  if (routerRelay) {
    logger.log(`  Executing summary command: [router mode]`);
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
    summaryText = response;
    tokensUsed = estimateTokens(fullPrompt) + estimateTokens(response);
  } else {
    logger.log(`  Executing summary command: ${reviewDeps.commandTemplate}`);
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
    tokensUsed = result.tokensUsed;
  }

  const sanitizedSummary = sanitizeTokens(summaryText);

  // Submit result — retry up to 3 times (highest-risk operation)
  await withRetry(
    () =>
      client.post(`/api/tasks/${taskId}/result`, {
        agent_id: agentId,
        type: 'summary' as ClaimRole,
        review_text: sanitizedSummary,
        tokens_used: tokensUsed,
      }),
    { maxAttempts: 3 },
    signal,
  );

  recordSessionUsage(consumptionDeps.session, tokensUsed);
  logger.log(`  Summary submitted (${tokensUsed.toLocaleString()} tokens)`);
  logger.log(formatPostReviewStats(consumptionDeps.session));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/**
 * Start an agent in polling mode.
 */
export async function startAgent(
  agentId: string,
  platformUrl: string,
  agentInfo: { model: string; tool: string },
  reviewDeps?: ReviewExecutorDeps,
  consumptionDeps?: ConsumptionDeps,
  options?: {
    pollIntervalMs?: number;
    maxConsecutiveErrors?: number;
    routerRelay?: RouterRelay;
    reviewOnly?: boolean;
    repoConfig?: RepoConfig;
    label?: string;
  },
): Promise<void> {
  const client = new ApiClient(platformUrl);
  const session = consumptionDeps?.session ?? createSessionTracker();
  const deps = consumptionDeps ?? { agentId, session };
  const logger = createLogger(options?.label);
  const { log, logError, logWarn } = logger;

  log(`Agent ${agentId} starting...`);
  log(`Platform: ${platformUrl}`);
  log(`Model: ${agentInfo.model} | Tool: ${agentInfo.tool}`);

  if (!reviewDeps) {
    logError('No review command configured. Set command in config.yml');
    return;
  }

  // Dry-run test: verify command works before entering poll loop.
  // Skip in router mode (stdin/stdout relay) since there's no local command to test.
  if (reviewDeps.commandTemplate && !options?.routerRelay) {
    log('Testing command...');
    const result = await testCommand(reviewDeps.commandTemplate);
    if (result.ok) {
      log(`Testing command... ok (${(result.elapsedMs / 1000).toFixed(1)}s)`);
    } else {
      logWarn(`Warning: command test failed (${result.error}). Reviews may fail.`);
    }
  }

  const abortController = new AbortController();

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    log('\nShutting down...');
    abortController.abort();
  });
  process.on('SIGTERM', () => {
    abortController.abort();
  });

  await pollLoop(client, agentId, reviewDeps, deps, agentInfo, logger, {
    pollIntervalMs: options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    maxConsecutiveErrors: options?.maxConsecutiveErrors ?? DEFAULT_MAX_CONSECUTIVE_ERRORS,
    routerRelay: options?.routerRelay,
    reviewOnly: options?.reviewOnly,
    repoConfig: options?.repoConfig,
    signal: abortController.signal,
  });

  log('Agent stopped.');
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

  const configToken = resolveConfigToken(agentConfig?.github_token, config.githubToken);
  const auth = resolveGithubToken(configToken);
  const logger = createLogger(agentConfig?.name ?? 'agent[0]');
  logAuthMethod(auth.method, logger.log);

  const codebaseDir = resolveCodebaseDir(agentConfig?.codebase_dir, config.codebaseDir);
  const reviewDeps: ReviewExecutorDeps = {
    commandTemplate: commandTemplate ?? '',
    maxDiffSizeKb: config.maxDiffSizeKb,
    githubToken: auth.token,
    codebaseDir,
  };

  const session = createSessionTracker();

  const model = agentConfig?.model ?? 'unknown';
  const tool = agentConfig?.tool ?? 'unknown';
  const label = agentConfig?.name ?? 'agent[0]';

  await startAgent(
    agentId,
    config.platformUrl,
    { model, tool },
    reviewDeps,
    {
      agentId,
      session,
    },
    {
      maxConsecutiveErrors: config.maxConsecutiveErrors,
      routerRelay: router,
      reviewOnly: agentConfig?.review_only,
      repoConfig: agentConfig?.repos,
      label,
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
 * @param auth — pre-resolved GitHub auth (env/gh-cli/config fallback chain).
 *               When the auth method is 'config' or 'none', per-agent config
 *               token overrides the global config token.
 */
function startAgentByIndex(
  config: ReturnType<typeof loadConfig>,
  agentIndex: number,
  pollIntervalMs: number,
  auth: GithubAuthResult,
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

  // If auth was resolved from env or gh-cli, use that token for all agents.
  // Otherwise, re-resolve per-agent config token (per-agent overrides global).
  let githubToken: string | null;
  if (auth.method === 'env' || auth.method === 'gh-cli') {
    githubToken = auth.token;
  } else {
    const configToken = agentConfig
      ? resolveConfigToken(agentConfig.github_token, config.githubToken)
      : config.githubToken;
    githubToken = configToken;
  }

  const codebaseDir = resolveCodebaseDir(agentConfig?.codebase_dir, config.codebaseDir);
  const reviewDeps: ReviewExecutorDeps = {
    commandTemplate,
    maxDiffSizeKb: config.maxDiffSizeKb,
    githubToken,
    codebaseDir,
  };

  const isRouter = agentConfig?.router === true;
  let routerRelay: RouterRelay | undefined;
  if (isRouter) {
    routerRelay = new RouterRelay();
    routerRelay.start();
  }

  const session = createSessionTracker();
  const model = agentConfig?.model ?? 'unknown';
  const tool = agentConfig?.tool ?? 'unknown';

  const agentPromise = startAgent(
    agentId,
    config.platformUrl,
    { model, tool },
    reviewDeps,
    { agentId, session },
    {
      pollIntervalMs,
      maxConsecutiveErrors: config.maxConsecutiveErrors,
      routerRelay,
      reviewOnly: agentConfig?.review_only,
      repoConfig: agentConfig?.repos,
      label,
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
  .option('--agent <index>', 'Agent index from config.yml (0-based)', '0')
  .option('--all', 'Start all configured agents concurrently')
  .action(async (opts: { pollInterval: string; agent: string; all?: boolean }) => {
    const config = loadConfig();
    const pollIntervalMs = parseInt(opts.pollInterval, 10) * 1000;

    // Resolve GitHub auth once at startup (env → gh-cli → config → none)
    const configToken = resolveConfigToken(undefined, config.githubToken);
    const auth = resolveGithubToken(configToken);
    logAuthMethod(auth.method, console.log.bind(console));

    if (opts.all) {
      // Start all agents concurrently
      if (!config.agents || config.agents.length === 0) {
        console.error('No agents configured in ~/.opencara/config.yml');
        process.exit(1);
        return;
      }

      console.log(`Starting ${config.agents.length} agent(s)...`);

      const promises: Promise<void>[] = [];
      let startFailed = false;
      for (let i = 0; i < config.agents.length; i++) {
        const p = startAgentByIndex(config, i, pollIntervalMs, auth);
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
            : 'No agents configured in ~/.opencara/config.yml',
        );
        process.exit(1);
        return;
      }
      const p = startAgentByIndex(config, agentIndex, pollIntervalMs, auth);
      if (!p) {
        // startAgentByIndex already logged the specific reason
        process.exit(1);
        return;
      }
      await p;
    }
  });
