import { Command } from 'commander';
import crypto from 'node:crypto';
import type {
  PollResponse,
  PollTask,
  ClaimResponse,
  ClaimReview,
  ReviewVerdict,
  ClaimRole,
} from '@opencara/shared';
import {
  loadConfig,
  resolveAgentLimits,
  resolveCodebaseDir,
  resolveGithubToken as resolveConfigToken,
  type ConsumptionLimits,
  type LocalAgentConfig,
} from '../config.js';
import { cloneOrUpdate } from '../codebase.js';
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

export interface ConsumptionDeps {
  agentId: string;
  limits: ConsumptionLimits | null;
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
    log: (msg: string) => console.log(`${prefix}${msg}`),
    logError: (msg: string) => console.error(`${prefix}${msg}`),
    logWarn: (msg: string) => console.warn(`${prefix}${msg}`),
  };
}

/** HTTP statuses that will never succeed on retry (auth/not-found). */
const NON_RETRYABLE_STATUSES = new Set([401, 403, 404]);

/**
 * Fetch the PR diff directly from GitHub.
 * Agent fetches diff itself — server never sends it.
 * When githubToken is provided, sends Authorization header (required for private repos).
 */
async function fetchDiff(
  diffUrl: string,
  githubToken?: string | null,
  signal?: AbortSignal,
): Promise<string> {
  // Append .diff if not already present for GitHub's raw diff format
  const patchUrl = diffUrl.endsWith('.diff') ? diffUrl : `${diffUrl}.diff`;

  return withRetry(
    async () => {
      const headers: Record<string, string> = {};
      if (githubToken) {
        headers['Authorization'] = `Bearer ${githubToken}`;
      }
      const response = await fetch(patchUrl, { headers });
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
    routerRelay?: RouterRelay;
    reviewOnly?: boolean;
    signal?: AbortSignal;
  },
): Promise<void> {
  const { pollIntervalMs, routerRelay, reviewOnly, signal } = options;
  const { log, logError, logWarn } = logger;

  log(`Agent ${agentId} polling every ${pollIntervalMs / 1000}s...`);

  let consecutiveAuthErrors = 0;
  let consecutiveErrors = 0;

  while (!signal?.aborted) {
    try {
      // Poll for tasks
      const pollBody: Record<string, unknown> = { agent_id: agentId };
      if (reviewOnly) pollBody.review_only = true;
      const pollResponse = await client.post<PollResponse>('/api/tasks/poll', pollBody);

      consecutiveAuthErrors = 0;
      consecutiveErrors = 0;

      if (pollResponse.tasks.length > 0) {
        const task = pollResponse.tasks[0]; // Take first available task
        await handleTask(
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
): Promise<void> {
  const { task_id, owner, repo, pr_number, diff_url, timeout_seconds, prompt, role } = task;
  const { log, logError, logWarn } = logger;

  log(`\nTask ${task_id}: PR #${pr_number} on ${owner}/${repo} (role: ${role})`);
  log(`  ${diff_url}`);

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
    return;
  }

  if (!claimResponse.claimed) {
    log(`  Claim rejected: ${(claimResponse as { reason: string }).reason}`);
    return;
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
    return;
  }

  // Clone/update codebase if configured
  let taskReviewDeps = reviewDeps;
  if (reviewDeps.codebaseDir) {
    try {
      const result = cloneOrUpdate(
        owner,
        repo,
        pr_number,
        reviewDeps.codebaseDir,
        reviewDeps.githubToken,
      );
      log(`  Codebase ${result.cloned ? 'cloned' : 'updated'}: ${result.localPath}`);
      // Pass the resolved local path as codebaseDir for this task
      taskReviewDeps = { ...reviewDeps, codebaseDir: result.localPath };
    } catch (err) {
      logWarn(
        `  Warning: codebase clone failed: ${(err as Error).message}. Continuing with diff-only review.`,
      );
      taskReviewDeps = { ...reviewDeps, codebaseDir: undefined };
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
        routerRelay,
        signal,
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
  }
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
      () => client.post(`/api/tasks/${taskId}/reject`, { agent_id: agentId, reason }),
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
    await withRetry(() => client.post(`/api/tasks/${taskId}/error`, { agent_id: agentId, error }), {
      maxAttempts: 2,
    });
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
): Promise<void> {
  let reviewText: string;
  let verdict: ReviewVerdict;
  let tokensUsed: number;

  if (routerRelay) {
    // Router mode: relay to external agent
    const fullPrompt = routerRelay.buildReviewPrompt({
      owner,
      repo,
      reviewMode: 'full',
      prompt,
      diffContent,
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
      },
      reviewDeps,
    );
    reviewText = result.review;
    verdict = result.verdict;
    tokensUsed = result.tokensUsed;
  }

  // Submit result — retry up to 3 times (highest-risk operation)
  await withRetry(
    () =>
      client.post(`/api/tasks/${taskId}/result`, {
        agent_id: agentId,
        type: 'review' as ClaimRole,
        review_text: reviewText,
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
): Promise<void> {
  if (reviews.length === 0) {
    // Single-agent mode: this IS the review, just run it as a regular review
    return executeReviewTask(
      client,
      agentId,
      taskId,
      owner,
      repo,
      prNumber,
      diffContent,
      prompt,
      timeoutSeconds,
      reviewDeps,
      consumptionDeps,
      logger,
      routerRelay,
      signal,
    );
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
    const fullPrompt = routerRelay.buildSummaryPrompt({
      owner,
      repo,
      prompt,
      reviews: summaryReviews,
      diffContent,
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
      },
      reviewDeps,
    );
    summaryText = result.summary;
    tokensUsed = result.tokensUsed;
  }

  // Submit result — retry up to 3 times (highest-risk operation)
  await withRetry(
    () =>
      client.post(`/api/tasks/${taskId}/result`, {
        agent_id: agentId,
        type: 'summary' as ClaimRole,
        review_text: summaryText,
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
    routerRelay?: RouterRelay;
    reviewOnly?: boolean;
    label?: string;
  },
): Promise<void> {
  const client = new ApiClient(platformUrl);
  const session = consumptionDeps?.session ?? createSessionTracker();
  const deps = consumptionDeps ?? { agentId, limits: null, session };
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
    routerRelay: options?.routerRelay,
    reviewOnly: options?.reviewOnly,
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
  const limits = agentConfig
    ? resolveAgentLimits(agentConfig.limits, config.limits)
    : config.limits;

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
      limits,
      session,
    },
    {
      routerRelay: router,
      reviewOnly: agentConfig?.review_only,
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
  let limits: ConsumptionLimits | null = config.limits;
  let agentConfig: LocalAgentConfig | undefined;

  if (config.agents && config.agents.length > agentIndex) {
    agentConfig = config.agents[agentIndex];
    commandTemplate = agentConfig.command ?? config.agentCommand ?? undefined;
    limits = resolveAgentLimits(agentConfig.limits, config.limits);
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
    { agentId, limits, session },
    {
      pollIntervalMs,
      routerRelay,
      reviewOnly: agentConfig?.review_only,
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
