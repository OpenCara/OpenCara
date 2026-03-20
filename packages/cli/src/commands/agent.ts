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
  type ConsumptionLimits,
  type LocalAgentConfig,
} from '../config.js';
import { ApiClient } from '../http.js';
import { executeReview, DiffTooLargeError, type ReviewExecutorDeps } from '../review.js';
import { executeSummary, InputTooLargeError } from '../summary.js';
import { validateCommandBinary, estimateTokens } from '../tool-executor.js';
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

/**
 * Fetch the PR diff directly from GitHub (public URL).
 * Agent fetches diff itself — server never sends it.
 */
async function fetchDiff(diffUrl: string): Promise<string> {
  // Append .diff if not already present for GitHub's raw diff format
  const patchUrl = diffUrl.endsWith('.diff') ? diffUrl : `${diffUrl}.diff`;
  const response = await fetch(patchUrl);

  if (!response.ok) {
    throw new Error(`Failed to fetch diff: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

/**
 * Poll → Claim → Review → Submit loop for a single agent.
 */
async function pollLoop(
  client: ApiClient,
  agentId: string,
  reviewDeps: ReviewExecutorDeps,
  consumptionDeps: ConsumptionDeps,
  options: {
    pollIntervalMs: number;
    routerRelay?: RouterRelay;
    signal?: AbortSignal;
  },
): Promise<void> {
  const { pollIntervalMs, routerRelay, signal } = options;

  console.log(`Agent ${agentId} polling every ${pollIntervalMs / 1000}s...`);

  while (!signal?.aborted) {
    try {
      // Poll for tasks
      const pollResponse = await client.post<PollResponse>('/api/tasks/poll', {
        agent_id: agentId,
      });

      if (pollResponse.tasks.length > 0) {
        const task = pollResponse.tasks[0]; // Take first available task
        await handleTask(client, agentId, task, reviewDeps, consumptionDeps, routerRelay);
      }
    } catch (err) {
      if (signal?.aborted) break;
      console.error('Poll error:', (err as Error).message);
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
  routerRelay?: RouterRelay,
): Promise<void> {
  const { task_id, owner, repo, pr_number, diff_url, timeout_seconds, prompt, role } = task;

  console.log(`\nTask ${task_id}: PR #${pr_number} on ${owner}/${repo} (role: ${role})`);

  // Claim the task
  let claimResponse: ClaimResponse;
  try {
    claimResponse = await client.post<ClaimResponse>(`/api/tasks/${task_id}/claim`, {
      agent_id: agentId,
      role,
    });
  } catch (err) {
    console.error(`  Failed to claim: ${(err as Error).message}`);
    return;
  }

  if (!claimResponse.claimed) {
    console.log(`  Claim rejected: ${(claimResponse as { reason: string }).reason}`);
    return;
  }

  console.log(`  Claimed as ${role}`);

  // Fetch diff
  let diffContent: string;
  try {
    diffContent = await fetchDiff(diff_url);
    console.log(`  Diff fetched (${Math.round(diffContent.length / 1024)}KB)`);
  } catch (err) {
    console.error(`  Failed to fetch diff: ${(err as Error).message}`);
    await client.post(`/api/tasks/${task_id}/reject`, {
      agent_id: agentId,
      reason: `Cannot access diff: ${(err as Error).message}`,
    });
    return;
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
        reviewDeps,
        consumptionDeps,
        routerRelay,
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
        reviewDeps,
        consumptionDeps,
        routerRelay,
      );
    }
  } catch (err) {
    if (err instanceof DiffTooLargeError) {
      console.error(`  ${err.message}`);
      await client.post(`/api/tasks/${task_id}/reject`, {
        agent_id: agentId,
        reason: err.message,
      });
    } else if (err instanceof InputTooLargeError) {
      console.error(`  ${err.message}`);
      await client.post(`/api/tasks/${task_id}/reject`, {
        agent_id: agentId,
        reason: err.message,
      });
    } else {
      console.error(`  Error: ${(err as Error).message}`);
      await client.post(`/api/tasks/${task_id}/error`, {
        agent_id: agentId,
        error: (err as Error).message,
      });
    }
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
  routerRelay?: RouterRelay,
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

  // Submit result
  await client.post(`/api/tasks/${taskId}/result`, {
    agent_id: agentId,
    type: 'review' as ClaimRole,
    review_text: reviewText,
    verdict,
    tokens_used: tokensUsed,
  });

  recordSessionUsage(consumptionDeps.session, tokensUsed);
  console.log(`  Review submitted (${tokensUsed.toLocaleString()} tokens)`);
  console.log(formatPostReviewStats(tokensUsed, consumptionDeps.session, consumptionDeps.limits));
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
  routerRelay?: RouterRelay,
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
      routerRelay,
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

  await client.post(`/api/tasks/${taskId}/result`, {
    agent_id: agentId,
    type: 'summary' as ClaimRole,
    review_text: summaryText,
    tokens_used: tokensUsed,
  });

  recordSessionUsage(consumptionDeps.session, tokensUsed);
  console.log(`  Summary submitted (${tokensUsed.toLocaleString()} tokens)`);
  console.log(formatPostReviewStats(tokensUsed, consumptionDeps.session, consumptionDeps.limits));
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
  _apiKey: string | null,
  reviewDeps?: ReviewExecutorDeps,
  consumptionDeps?: ConsumptionDeps,
  options?: { pollIntervalMs?: number; routerRelay?: RouterRelay },
): Promise<void> {
  const client = new ApiClient(platformUrl);
  const session = consumptionDeps?.session ?? createSessionTracker();
  const deps = consumptionDeps ?? { agentId, limits: null, session };

  console.log(`Agent ${agentId} starting...`);
  console.log(`Platform: ${platformUrl}`);

  if (!reviewDeps) {
    console.error('No review command configured. Set command in config.yml');
    return;
  }

  const abortController = new AbortController();

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('\nShutting down...');
    abortController.abort();
  });
  process.on('SIGTERM', () => {
    abortController.abort();
  });

  await pollLoop(client, agentId, reviewDeps, deps, {
    pollIntervalMs: options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    routerRelay: options?.routerRelay,
    signal: abortController.signal,
  });

  console.log('Agent stopped.');
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

  const reviewDeps: ReviewExecutorDeps = {
    commandTemplate: commandTemplate ?? '',
    maxDiffSizeKb: config.maxDiffSizeKb,
  };

  const session = createSessionTracker();
  const limits = agentConfig
    ? resolveAgentLimits(agentConfig.limits, config.limits)
    : config.limits;

  await startAgent(
    agentId,
    config.platformUrl,
    null,
    reviewDeps,
    {
      agentId,
      limits,
      session,
    },
    {
      routerRelay: router,
    },
  );

  router.stop();
}

// ── CLI Commands ─────────────────────────────────────────────

export const agentCommand = new Command('agent').description('Manage review agents');

agentCommand
  .command('start')
  .description('Start an agent in polling mode')
  .option('--poll-interval <seconds>', 'Poll interval in seconds', '10')
  .option('--agent <index>', 'Agent index from config.yml (0-based)', '0')
  .action(async (opts: { pollInterval: string; agent: string }) => {
    const config = loadConfig();
    const pollIntervalMs = parseInt(opts.pollInterval, 10) * 1000;
    const agentIndex = parseInt(opts.agent, 10);

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

    if (!commandTemplate) {
      console.error(
        'No command configured. Set agent_command or agents[].command in ~/.opencara/config.yml',
      );
      process.exit(1);
    }

    if (!validateCommandBinary(commandTemplate)) {
      console.error(`Command binary not found: ${commandTemplate.split(' ')[0]}`);
      process.exit(1);
    }

    const reviewDeps: ReviewExecutorDeps = {
      commandTemplate,
      maxDiffSizeKb: config.maxDiffSizeKb,
    };

    const isRouter = agentConfig?.router === true;
    let routerRelay: RouterRelay | undefined;
    if (isRouter) {
      routerRelay = new RouterRelay();
      routerRelay.start();
    }

    const session = createSessionTracker();

    try {
      await startAgent(
        agentId,
        config.platformUrl,
        null,
        reviewDeps,
        {
          agentId,
          limits,
          session,
        },
        {
          pollIntervalMs,
          routerRelay,
        },
      );
    } finally {
      routerRelay?.stop();
    }
  });
