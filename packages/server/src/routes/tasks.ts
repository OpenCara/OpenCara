import { Hono } from 'hono';
import type {
  PollResponse,
  PollTask,
  ClaimResponse,
  ResultResponse,
  ReviewVerdict,
  ReviewTask,
} from '@opencara/shared';
import { isRepoAllowed, isEntityMatch } from '@opencara/shared';
import type { Env, AppVariables } from '../types.js';
import type { DataStore } from '../store/interface.js';
import type { GitHubService } from '../github/service.js';
import type { Logger } from '../logger.js';
import { createLogger } from '../logger.js';
import {
  formatTimeoutComment,
  wrapReviewComment,
  type TimeoutReview,
} from '../review-formatter.js';
import {
  CLAIM_STALE_THRESHOLD_MS,
  SUMMARY_SLOT_STALE_THRESHOLD_MS,
  AGENT_REJECTION_THRESHOLD,
  AGENT_REJECTION_WINDOW_MS,
} from '../store/constants.js';
import { isAgentEligibleForRole } from '../eligibility.js';
import { rateLimitByAgent } from '../middleware/rate-limit.js';
import { requireApiKey } from '../middleware/auth.js';
import { requireOAuth } from '../middleware/oauth.js';
import { apiError } from '../errors.js';
import {
  parseBody,
  PollRequestSchema,
  ClaimRequestSchema,
  ResultRequestSchema,
  RejectRequestSchema,
  ErrorRequestSchema,
  REVIEW_TEXT_MIN_LENGTH,
  REVIEW_TEXT_MAX_LENGTH,
} from '../schemas.js';

/** Default grace period (ms) for preferred synthesizer agents. */
export const PREFERRED_SYNTH_GRACE_PERIOD_MS = 60_000;

/** Grace period (ms) for preferred review agents (model/tool matching). */
export const PREFERRED_REVIEW_GRACE_PERIOD_MS = 30_000;

/**
 * Check if an agent's model/tool matches the review preferences in the config.
 * Returns true if no preferences are set (backward compatible) or if the agent matches.
 */
function isReviewPreferredAgent(
  config: ReviewTask['config'],
  model?: string,
  tool?: string,
): boolean {
  const { preferredModels, preferredTools } = config.agents;
  if (preferredModels.length === 0 && preferredTools.length === 0) return true;
  if (model && preferredModels.includes(model)) return true;
  if (tool && preferredTools.includes(tool)) return true;
  return false;
}

/**
 * Check if a review queue task is visible to the given agent, considering
 * the preferred model/tool grace period.
 *
 * - If no preferred list is configured, review is available immediately.
 * - If the agent matches a preferred model/tool, review is available immediately.
 * - If the agent does NOT match, review is only available after the grace period.
 */
function isReviewVisibleToAgent(task: ReviewTask, model?: string, tool?: string): boolean {
  if (isReviewPreferredAgent(task.config, model, tool)) return true;
  return Date.now() - task.created_at >= PREFERRED_REVIEW_GRACE_PERIOD_MS;
}

/**
 * Check if a summary queue task is visible to the given agent, considering
 * the preferred synthesizer grace period.
 *
 * - If no preferred list is configured, summary is available immediately.
 * - If the agent is in the preferred list, summary is available immediately.
 * - If the agent is NOT preferred, summary is only available after the grace period
 *   has elapsed since the task entered the summary queue.
 */
function isSummaryVisibleToAgent(task: ReviewTask, agentId: string): boolean {
  const preferred = task.config?.summarizer?.preferred ?? [];
  if (preferred.length === 0) return true;

  const isPreferred = preferred.some((p) => isEntityMatch(p, agentId));
  if (isPreferred) return true;

  // Non-preferred agent: check if grace period has elapsed
  // For review_count=1 (no review phase), use task creation time as the baseline
  const graceStart = task.reviews_completed_at ?? (task.review_count === 1 ? task.created_at : 0);
  if (!graceStart) return false; // reviews not yet completed
  return Date.now() - graceStart >= PREFERRED_SYNTH_GRACE_PERIOD_MS;
}

/**
 * Throttle timeout checks to avoid O(n) KV scans on every poll request.
 * The last-check timestamp is stored in KV (via DataStore) so it survives
 * isolate recycles. Note: the get-set sequence is not atomic, so concurrent
 * isolates may occasionally both pass the threshold — still far better than
 * checking on every poll.
 */
export const TIMEOUT_CHECK_INTERVAL_MS = 30_000;

/**
 * No-op — kept for backward compatibility with tests.
 * Throttle state is now stored in DataStore, so fresh store creation
 * (or MemoryDataStore.reset()) handles the reset.
 * @deprecated Use a fresh DataStore instance instead.
 */
export function resetTimeoutThrottle(): void {
  // no-op — throttle state is now in DataStore, not module-level
}

async function maybeCheckTimeouts(
  store: DataStore,
  github: GitHubService,
  logger: Logger,
): Promise<void> {
  const now = Date.now();
  const lastCheck = await store.getTimeoutLastCheck();
  if (now - lastCheck < TIMEOUT_CHECK_INTERVAL_MS) return;
  await store.setTimeoutLastCheck(now);
  await checkTimeouts(store, github, logger);
}

/**
 * Check for timed-out tasks and handle them.
 * Exported for use by the scheduled event handler (Cron Trigger).
 */
export async function checkTimeouts(
  store: DataStore,
  github: GitHubService,
  logger?: Logger,
): Promise<void> {
  const log = logger ?? createLogger();

  // Reclaim abandoned claims and summary slots from stale agents
  const freedClaims = await store.reclaimAbandonedClaims(CLAIM_STALE_THRESHOLD_MS);
  if (freedClaims > 0) {
    log.info('Reclaimed abandoned claims', { freedClaims });
  }
  const freedSlots = await store.reclaimAbandonedSummarySlots(SUMMARY_SLOT_STALE_THRESHOLD_MS);
  if (freedSlots > 0) {
    log.info('Reclaimed abandoned summary slots', { freedSlots });
  }

  const now = Date.now();
  const expired = await store.listTasks({
    status: ['pending', 'reviewing'],
    timeout_before: now,
  });

  for (const task of expired) {
    log.info('Task timed out', {
      taskId: task.id,
      owner: task.owner,
      repo: task.repo,
      prNumber: task.pr_number,
    });

    // Post fallback: any completed reviews as individual comments
    const claims = await store.getClaims(task.id);

    // Log structured errors for each pending claim that timed out
    for (const claim of claims.filter((c) => c.status === 'pending')) {
      log.error('Agent claim timed out', {
        agentId: claim.agent_id,
        taskId: task.id,
        action: 'timeout',
        role: claim.role,
      });
    }
    const completedReviews = claims.filter(
      (c) => c.role === 'review' && c.status === 'completed' && c.review_text,
    );

    try {
      const token = await github.getInstallationToken(task.github_installation_id);
      const timeoutMinutes = Math.round((task.timeout_at - task.created_at) / 60000);

      const reviews: TimeoutReview[] = completedReviews.map((claim) => ({
        model: claim.model ?? 'unknown',
        tool: claim.tool ?? 'unknown',
        thinking: claim.thinking,
        verdict: (claim.verdict as ReviewVerdict) ?? 'comment',
        review_text: claim.review_text!,
      }));

      const body = formatTimeoutComment(timeoutMinutes, reviews);
      await github.postPrComment(task.owner, task.repo, task.pr_number, body, token);

      // Only delete AFTER posting succeeds — if posting fails,
      // leave task in current state so next checkTimeouts() retries.
      // If deleteTask fails after post succeeds, cleanupTerminalTasks
      // will eventually clean up the orphaned task.
      await store.deleteTask(task.id);
    } catch (err) {
      log.error('Timeout post failed', {
        taskId: task.id,
        action: 'timeout_post_failed',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/** Data passed directly from the result endpoint to avoid KV read-after-write staleness. */
export interface SummaryData {
  review_text: string;
}

/**
 * Post the final review to GitHub when a task is complete.
 * For summary role: post the synthesized/single review with inline comments.
 *
 * Summary data is passed directly from the result endpoint rather than
 * re-read from KV, because KV eventual consistency (30-60s) can cause
 * the re-read to return stale data without review_text, silently dropping
 * the review.
 */
async function postFinalReview(
  store: DataStore,
  github: GitHubService,
  taskId: string,
  summaryAgentId: string,
  summaryData: SummaryData,
  logger: Logger,
): Promise<void> {
  const task = await store.getTask(taskId);
  if (!task) return;

  // Defense-in-depth: if task is already completed, another agent already posted.
  if (task.status === 'completed' || task.queue === 'completed') {
    logger.info('Skipping duplicate post — task already completed', {
      taskId,
      agentId: summaryAgentId,
    });
    return;
  }

  // Final guard: validate review_text before posting to GitHub
  const trimmed = summaryData.review_text.trim();
  if (trimmed.length < REVIEW_TEXT_MIN_LENGTH) {
    logger.error('Final review guard — review_text too short, skipping GitHub post', {
      taskId,
      agentId: summaryAgentId,
      length: trimmed.length,
    });
    await store.releaseSummarySlot(taskId);
    await store.updateTask(taskId, { status: 'reviewing' });
    return;
  }

  // Collect unique contributors from all claims — non-fatal on failure
  let contributors: string[] = [];
  try {
    const claims = await store.getClaims(taskId);
    contributors = [
      ...new Set(claims.map((c) => c.github_username).filter((u): u is string => !!u)),
    ];
  } catch {
    // Non-fatal — post review without contributor attribution
  }

  try {
    const token = await github.getInstallationToken(task.github_installation_id);

    // Wrap review_text with consistent branding header/footer
    const body = wrapReviewComment(trimmed, contributors.length > 0 ? contributors : undefined);
    await github.postPrComment(task.owner, task.repo, task.pr_number, body, token);

    await store.deleteTask(taskId);
    logger.info('Review posted to GitHub — task deleted', {
      taskId,
      owner: task.owner,
      repo: task.repo,
      prNumber: task.pr_number,
    });
  } catch (err) {
    logger.error('Failed to post review to GitHub', {
      agentId: summaryAgentId,
      taskId,
      action: 'post_review_failed',
      error: err instanceof Error ? err.message : String(err),
    });
    // On failure, move task back to summary queue so another agent can retry
    await store.releaseSummarySlot(taskId);
    await store.updateTask(taskId, { status: 'reviewing' });
  }
}

/** Check if an agent is blocked due to exceeding the rejection threshold. */
async function isAgentBlocked(store: DataStore, agentId: string): Promise<boolean> {
  const since = Date.now() - AGENT_REJECTION_WINDOW_MS;
  const count = await store.countAgentRejections(agentId, since);
  return count >= AGENT_REJECTION_THRESHOLD;
}

/** Rate limit configs for task endpoints. */
export const POLL_RATE_LIMIT = { maxRequests: 12, windowMs: 60_000 };
export const MUTATION_RATE_LIMIT = { maxRequests: 30, windowMs: 60_000 };

export function taskRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  // Auth: OAuth when OAUTH_REQUIRED=true, otherwise fall back to API key auth.
  // Pre-instantiate middleware to avoid allocating closures per request.
  const oauthMiddleware = requireOAuth();
  const apiKeyMiddleware = requireApiKey();
  app.use('/api/tasks/*', async (c, next) => {
    return c.env.OAUTH_REQUIRED === 'true' ? oauthMiddleware(c, next) : apiKeyMiddleware(c, next);
  });

  // ── Poll ─────────────────────────────────────────────────────

  app.post('/api/tasks/poll', rateLimitByAgent(POLL_RATE_LIMIT), async (c) => {
    const store = c.get('store');
    const github = c.get('github');
    const logger = c.get('logger');
    const verifiedIdentity = c.get('verifiedIdentity');
    const body = await parseBody(c, PollRequestSchema);
    if (body instanceof Response) return body;
    const { agent_id, roles, review_only, repos, synthesize_repos } = body;

    // Block check — reject agents exceeding the rejection threshold
    if (await isAgentBlocked(store, agent_id)) {
      logger.warn('Blocked agent attempted poll', { agentId: agent_id });
      return apiError(
        c,
        403,
        'AGENT_BLOCKED',
        'Agent is temporarily blocked due to repeated review rejections',
      );
    }

    // Determine which roles this agent will accept
    // `roles` takes precedence over deprecated `review_only`
    const acceptedRoles: Set<string> | null = roles
      ? new Set(roles)
      : review_only
        ? new Set(['review'])
        : null; // null = accept all roles

    // Build a set of repos the agent declares for fast lookup
    const agentRepos = repos && repos.length > 0 ? new Set(repos) : null;

    // Update last-seen
    await store.setAgentLastSeen(agent_id, Date.now());

    // Check timeouts lazily (throttled to every 30s per isolate)
    await maybeCheckTimeouts(store, github, logger);

    // Find available tasks — only active tasks (pending/reviewing)
    const tasks = await store.listTasks({ status: ['pending', 'reviewing'] });
    const tasksById = new Map(tasks.map((t) => [t.id, t]));
    const available: PollTask[] = [];

    for (const task of tasks) {
      // Private repo tasks: only return to agents declaring matching repos
      if (task.private && (!agentRepos || !agentRepos.has(`${task.owner}/${task.repo}`))) {
        continue;
      }

      const remainingMs = task.timeout_at - Date.now();
      if (remainingMs <= 0) continue;

      // Queue-based role assignment
      if (task.queue === 'summary') {
        // Summary queue — check role filter, eligibility, grace period, and repo preference
        if (acceptedRoles && !acceptedRoles.has('summary')) continue;
        const { eligible } = isAgentEligibleForRole(
          task.config,
          'summary',
          agent_id,
          verifiedIdentity?.github_username,
        );
        if (!eligible) continue;
        if (!isSummaryVisibleToAgent(task, agent_id)) continue;

        // synthesize_repos filter — if provided, only offer summary tasks for matching repos
        if (synthesize_repos) {
          if (!isRepoAllowed(synthesize_repos, task.owner, task.repo)) continue;
        }

        // Check if agent already has a summary claim on this task
        const existingSummaryClaim = await store.getClaim(`${task.id}:${agent_id}:summary`);
        if (
          existingSummaryClaim &&
          existingSummaryClaim.status !== 'rejected' &&
          existingSummaryClaim.status !== 'error'
        ) {
          continue;
        }

        available.push({
          task_id: task.id,
          owner: task.owner,
          repo: task.repo,
          pr_number: task.pr_number,
          diff_url: task.diff_url,
          timeout_seconds: Math.max(0, Math.floor(remainingMs / 1000)),
          prompt: task.prompt,
          role: 'summary',
        });
      } else if (task.queue === 'review') {
        // Review queue — check role filter and review slots
        if (acceptedRoles && !acceptedRoles.has('review')) continue;
        const reviewSlots = task.review_count - 1;
        const reviewClaims = task.review_claims ?? 0;
        if (reviewClaims >= reviewSlots) continue;

        const { eligible } = isAgentEligibleForRole(
          task.config,
          'review',
          agent_id,
          verifiedIdentity?.github_username,
        );
        if (!eligible) continue;

        // Preferred model/tool grace period — non-preferred agents wait
        if (!isReviewVisibleToAgent(task, body.model, body.tool)) continue;

        // Check if agent already has a review claim on this task
        const existingClaim = await store.getClaim(`${task.id}:${agent_id}:review`);
        if (
          existingClaim &&
          existingClaim.status !== 'rejected' &&
          existingClaim.status !== 'error'
        ) {
          continue;
        }

        available.push({
          task_id: task.id,
          owner: task.owner,
          repo: task.repo,
          pr_number: task.pr_number,
          diff_url: task.diff_url,
          timeout_seconds: Math.max(0, Math.floor(remainingMs / 1000)),
          prompt: task.prompt,
          role: 'review',
        });
      }
      // Tasks in 'finished' or 'completed' queue are not pollable
    }

    // Sort preferred tasks first (only applies to review-role tasks)
    available.sort((a, b) => {
      if (a.role !== 'review' && b.role !== 'review') return 0;
      if (a.role !== 'review') return 1;
      if (b.role !== 'review') return -1;

      const aTask = tasksById.get(a.task_id);
      const bTask = tasksById.get(b.task_id);
      const aPref = aTask ? isReviewPreferredAgent(aTask.config, body.model, body.tool) : false;
      const bPref = bTask ? isReviewPreferredAgent(bTask.config, body.model, body.tool) : false;
      if (aPref && !bPref) return -1;
      if (!aPref && bPref) return 1;
      return 0;
    });

    return c.json<PollResponse>({ tasks: available });
  });

  // ── Claim ────────────────────────────────────────────────────

  app.post('/api/tasks/:taskId/claim', rateLimitByAgent(MUTATION_RATE_LIMIT), async (c) => {
    const store = c.get('store');
    const logger = c.get('logger');
    const verifiedIdentity = c.get('verifiedIdentity');
    const taskId = c.req.param('taskId');
    const body = await parseBody(c, ClaimRequestSchema);
    if (body instanceof Response) return body;
    const { agent_id, role, model, tool, thinking } = body;

    // Block check — reject agents exceeding the rejection threshold
    if (await isAgentBlocked(store, agent_id)) {
      logger.warn('Blocked agent attempted claim', { agentId: agent_id, taskId });
      return apiError(
        c,
        403,
        'AGENT_BLOCKED',
        'Agent is temporarily blocked due to repeated review rejections',
      );
    }

    const task = await store.getTask(taskId);
    if (!task) {
      return apiError(c, 404, 'TASK_NOT_FOUND', 'Task not found');
    }

    if (task.status !== 'pending' && task.status !== 'reviewing') {
      return apiError(c, 409, 'CLAIM_CONFLICT', `Task is ${task.status}`);
    }

    if (task.timeout_at <= Date.now()) {
      return apiError(c, 409, 'CLAIM_CONFLICT', 'Task has timed out');
    }

    // Check whitelist/blacklist eligibility before slot availability
    const eligibility = isAgentEligibleForRole(
      task.config,
      role,
      agent_id,
      verifiedIdentity?.github_username,
    );
    if (!eligibility.eligible) {
      return apiError(
        c,
        409,
        'CLAIM_CONFLICT',
        eligibility.reason ?? 'Agent not eligible for this role',
      );
    }

    // Queue-based claim validation
    if (role === 'review') {
      if (task.queue !== 'review') {
        return apiError(c, 409, 'CLAIM_CONFLICT', 'No review slots available');
      }
      // Atomic slot reservation — prevents concurrent oversubscription
      const reviewSlots = task.review_count - 1;
      const slotReserved = await store.claimReviewSlot(taskId, reviewSlots);
      if (!slotReserved) {
        return apiError(c, 409, 'CLAIM_CONFLICT', 'No review slots available');
      }
    } else if (role === 'summary') {
      if (task.queue !== 'summary') {
        return apiError(c, 409, 'CLAIM_CONFLICT', 'No slots available');
      }
      // Check preferred synthesizer grace period
      if (!isSummaryVisibleToAgent(task, agent_id)) {
        return apiError(c, 409, 'CLAIM_CONFLICT', 'No slots available');
      }
    }

    // For summary claims, use atomic CAS to prevent concurrent claims.
    // claimSummarySlot atomically sets queue='finished' + summary_agent_id
    // only if queue='summary', preventing the race where multiple agents
    // pass the queue check above.
    if (role === 'summary') {
      const claimed = await store.claimSummarySlot(taskId, agent_id);
      if (!claimed) {
        return apiError(c, 409, 'CLAIM_CONFLICT', 'Unable to claim summary slot');
      }
    }

    // Role-aware claim ID: allows reviewer to also claim summary later
    const claimId = `${taskId}:${agent_id}:${role}`;
    const claimCreated = await store.createClaim({
      id: claimId,
      task_id: taskId,
      agent_id,
      role,
      status: 'pending',
      model,
      tool,
      thinking,
      github_user_id: verifiedIdentity?.github_user_id,
      github_username: verifiedIdentity?.github_username,
      created_at: Date.now(),
    });
    if (!claimCreated) {
      if (role === 'review') {
        // Atomically release the reserved slot
        await store.releaseReviewSlot(taskId);
      } else if (role === 'summary') {
        await store.releaseSummarySlot(taskId);
      }
      return apiError(c, 409, 'CLAIM_CONFLICT', 'Agent already has a claim on this task');
    }

    // Update task state based on role
    // Note: review_claims increment is handled atomically by claimReviewSlot above
    // Note: summary queue/agent updates are handled by claimSummarySlot above
    if (task.status === 'pending') {
      await store.updateTask(taskId, { status: 'reviewing' });
    }

    // If summary role, include completed review texts
    if (role === 'summary') {
      const claims = await store.getClaims(taskId);
      const completedReviews = claims
        .filter((cl) => cl.role === 'review' && cl.status === 'completed' && cl.review_text)
        .map((cl) => ({
          agent_id: cl.agent_id,
          review_text: cl.review_text!,
          verdict: (cl.verdict ?? 'comment') as ReviewVerdict,
          model: cl.model,
          tool: cl.tool,
          thinking: cl.thinking,
        }));
      return c.json<ClaimResponse>({ claimed: true, reviews: completedReviews });
    }

    return c.json<ClaimResponse>({ claimed: true });
  });

  // ── Result ───────────────────────────────────────────────────

  app.post('/api/tasks/:taskId/result', rateLimitByAgent(MUTATION_RATE_LIMIT), async (c) => {
    const store = c.get('store');
    const github = c.get('github');
    const logger = c.get('logger');
    const taskId = c.req.param('taskId');

    // Manual JSON parsing (instead of parseBody) so we can extract agent_id
    // for abuse tracking even when review_text validation fails.
    let raw: Record<string, unknown>;
    try {
      raw = await c.req.json();
    } catch {
      return apiError(c, 400, 'INVALID_REQUEST', 'Malformed JSON body');
    }

    const result = ResultRequestSchema.safeParse(raw);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join('.') : undefined;
        return path ? `${path}: ${issue.message}` : issue.message;
      });

      // Record rejection for abuse tracking if review_text was the invalid field.
      // Only track when review_text is a string (non-string types are a different error).
      const agentId =
        typeof raw.agent_id === 'string' && raw.agent_id.length > 0 ? raw.agent_id : null;
      if (agentId && typeof raw.review_text === 'string') {
        const trimmed = raw.review_text.trim();
        if (trimmed.length < REVIEW_TEXT_MIN_LENGTH || trimmed.length > REVIEW_TEXT_MAX_LENGTH) {
          const reason = trimmed.length < REVIEW_TEXT_MIN_LENGTH ? 'too_short' : 'too_long';
          await store.recordAgentRejection(agentId, reason, Date.now());
          logger.warn('Review text rejected — abuse tracking recorded', {
            agentId,
            reason,
            length: trimmed.length,
          });
        }
      }

      return apiError(c, 400, 'INVALID_REQUEST', messages.join('; '));
    }

    const { agent_id, type, review_text, verdict, tokens_used } = result.data;

    // Role-aware claim lookup
    const claimId = `${taskId}:${agent_id}:${type}`;
    const claim = await store.getClaim(claimId);

    if (!claim) {
      logger.error('Result rejected — no claim found', { agentId: agent_id, taskId });
      return apiError(c, 404, 'CLAIM_NOT_FOUND', 'No claim found for this agent on this task');
    }

    if (claim.status !== 'pending') {
      logger.error('Result rejected — claim not pending', {
        agentId: agent_id,
        taskId,
        claimStatus: claim.status,
      });
      return apiError(c, 409, 'CLAIM_CONFLICT', `Claim already ${claim.status}`);
    }

    if (claim.role !== type) {
      logger.error('Result rejected — role mismatch', {
        agentId: agent_id,
        taskId,
        claimRole: claim.role,
        submissionType: type,
      });
      return apiError(
        c,
        400,
        'INVALID_REQUEST',
        `Claim role '${claim.role}' does not match submission type '${type}'`,
      );
    }

    // Update the claim with result
    await store.updateClaim(claimId, {
      status: 'completed',
      review_text,
      verdict: verdict as ReviewVerdict | undefined,
      tokens_used,
    });

    // Check if the task is now complete
    const task = await store.getTask(taskId);
    if (!task) {
      return c.json<ResultResponse>({ success: true });
    }

    if (type === 'summary') {
      // Verify this agent is the summary holder (queue-based check)
      if (task.summary_agent_id !== agent_id) {
        logger.info('Accepting result but skipping GitHub post — agent is not summary holder', {
          taskId,
          agentId: agent_id,
        });
        return c.json<ResultResponse>({ success: true });
      }

      // Summary submitted — post the final review to GitHub
      await postFinalReview(store, github, taskId, agent_id, { review_text }, logger);
    } else {
      // Review submitted — atomically increment completed_reviews counter
      const result = await store.incrementCompletedReviews(taskId);
      if (result) {
        const { newCount, queue } = result;
        const reviewSlots = task.review_count > 1 ? task.review_count - 1 : 0;
        if (reviewSlots > 0 && newCount >= reviewSlots && queue === 'review') {
          // All reviews done — move task to summary queue
          // Guard: only transition if queue is still 'review' to prevent
          // late review results from overwriting 'summary' or 'finished' state
          await store.updateTask(taskId, {
            queue: 'summary',
            reviews_completed_at: Date.now(),
          });
          logger.info('All reviews complete, task moved to summary queue', {
            taskId,
            reviewSlots,
          });
        }
      }
    }

    return c.json<ResultResponse>({ success: true });
  });

  // ── Reject ───────────────────────────────────────────────────

  app.post('/api/tasks/:taskId/reject', rateLimitByAgent(MUTATION_RATE_LIMIT), async (c) => {
    const store = c.get('store');
    const logger = c.get('logger');
    const taskId = c.req.param('taskId');
    const body = await parseBody(c, RejectRequestSchema);
    if (body instanceof Response) return body;
    const { agent_id, reason } = body;

    // Try role-aware claim IDs (summary first, then review)
    const claim = await findClaimForAgent(store, taskId, agent_id);

    if (!claim) {
      return apiError(c, 404, 'CLAIM_NOT_FOUND', 'Claim not found');
    }

    if (claim.status !== 'pending') {
      // Idempotent: already rejected → return 200
      if (claim.status === 'rejected') {
        return c.json({ success: true });
      }
      return apiError(c, 409, 'CLAIM_CONFLICT', `Claim is ${claim.status}, expected pending`);
    }

    await store.updateClaim(claim.id, { status: 'rejected' });

    // Free the slot so another agent can claim it (atomic to avoid races)
    if (claim.role === 'review') {
      await store.releaseReviewSlot(taskId);
    } else if (claim.role === 'summary') {
      await store.releaseSummarySlot(taskId);
    }

    logger.error('Agent rejected task', {
      agentId: agent_id,
      taskId,
      action: 'reject',
      role: claim.role,
      reason,
    });
    return c.json({ success: true });
  });

  // ── Error ────────────────────────────────────────────────────

  app.post('/api/tasks/:taskId/error', rateLimitByAgent(MUTATION_RATE_LIMIT), async (c) => {
    const store = c.get('store');
    const logger = c.get('logger');
    const taskId = c.req.param('taskId');
    const body = await parseBody(c, ErrorRequestSchema);
    if (body instanceof Response) return body;
    const { agent_id, error } = body;

    // Try role-aware claim IDs (summary first, then review)
    const claim = await findClaimForAgent(store, taskId, agent_id);

    if (!claim) {
      return apiError(c, 404, 'CLAIM_NOT_FOUND', 'Claim not found');
    }

    if (claim.status !== 'pending') {
      // Idempotent: already errored → return 200
      if (claim.status === 'error') {
        return c.json({ success: true });
      }
      return apiError(c, 409, 'CLAIM_CONFLICT', `Claim is ${claim.status}, expected pending`);
    }

    await store.updateClaim(claim.id, { status: 'error' });

    // Free the slot so another agent can claim it (atomic to avoid races)
    if (claim.role === 'review') {
      await store.releaseReviewSlot(taskId);
    } else if (claim.role === 'summary') {
      await store.releaseSummarySlot(taskId);
    }

    logger.error('Agent reported error', {
      agentId: agent_id,
      taskId,
      action: 'error',
      role: claim.role,
      error,
    });
    return c.json({ success: true });
  });

  return app;
}

/**
 * Find a pending claim for an agent on a task. Checks role-aware claim IDs
 * (summary first since that's the more impactful role to release).
 */
async function findClaimForAgent(
  store: DataStore,
  taskId: string,
  agentId: string,
): Promise<import('@opencara/shared').TaskClaim | null> {
  // Try summary claim first (higher priority to release)
  const summaryClaim = await store.getClaim(`${taskId}:${agentId}:summary`);
  if (summaryClaim && summaryClaim.status === 'pending') return summaryClaim;

  // Try review claim
  const reviewClaim = await store.getClaim(`${taskId}:${agentId}:review`);
  if (reviewClaim && reviewClaim.status === 'pending') return reviewClaim;

  // Return any found claim for idempotency checks (rejected/error/completed)
  if (summaryClaim) return summaryClaim;
  if (reviewClaim) return reviewClaim;

  return null;
}
