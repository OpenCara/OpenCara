import { Hono } from 'hono';
import type {
  PollRequest,
  PollResponse,
  PollTask,
  ClaimRequest,
  ClaimResponse,
  ResultRequest,
  ResultResponse,
  RejectRequest,
  ErrorRequest,
  ClaimRole,
  ReviewVerdict,
  ReviewTask,
} from '@opencara/shared';
import type { Env, AppVariables } from '../types.js';
import type { TaskStore } from '../store/interface.js';
import { getInstallationToken } from '../github/app.js';
import { postPrComment } from '../github/reviews.js';
import {
  formatSummaryComment,
  formatIndividualReviewComment,
  type ReviewAgentInfo,
} from '../review-formatter.js';
import { isAgentEligibleForRole } from '../eligibility.js';
import { rateLimitByAgent } from '../middleware/rate-limit.js';
import { apiError } from '../errors.js';

/** Default grace period (ms) for preferred synthesizer agents. */
export const PREFERRED_SYNTH_GRACE_PERIOD_MS = 60_000;

/**
 * Check if a summary role is available for the given agent, considering
 * the preferred synthesizer grace period.
 *
 * - If no preferred list is configured, summary is available immediately.
 * - If the agent is in the preferred list, summary is available immediately.
 * - If the agent is NOT preferred, summary is only available after the grace period
 *   has elapsed since all reviews were completed.
 */
function isSummaryAvailableForAgent(task: ReviewTask, agentId: string): boolean {
  const preferred = task.config?.summarizer?.preferred ?? [];
  if (preferred.length === 0) return true;

  const isPreferred = preferred.some((p) => p.agent === agentId);
  if (isPreferred) return true;

  // Non-preferred agent: check if grace period has elapsed
  // For review_count=1 (no review phase), use task creation time as the baseline
  const graceStart = task.reviews_completed_at ?? (task.review_count === 1 ? task.created_at : 0);
  if (!graceStart) return false; // reviews not yet completed
  return Date.now() - graceStart >= PREFERRED_SYNTH_GRACE_PERIOD_MS;
}

/**
 * Determine the available role for an agent on a task.
 * Uses task-level counters (not claim list queries) to avoid KV eventual consistency issues.
 * Returns null if no role is available.
 */
function availableRole(task: ReviewTask, agentId: string): ClaimRole | null {
  const claimedAgents = task.claimed_agents ?? [];
  if (claimedAgents.includes(agentId)) return null;

  const reviewClaims = task.review_claims ?? 0;
  const completedReviews = task.completed_reviews ?? 0;
  const summaryClaimed = task.summary_claimed ?? false;

  if (task.review_count === 1) {
    if (!summaryClaimed) {
      const { eligible } = isAgentEligibleForRole(task.config, 'summary', agentId);
      if (!eligible) return null;
      return isSummaryAvailableForAgent(task, agentId) ? 'summary' : null;
    }
    return null;
  }

  const reviewSlots = task.review_count - 1;
  if (reviewClaims < reviewSlots) {
    const { eligible } = isAgentEligibleForRole(task.config, 'review', agentId);
    if (eligible) return 'review';
  }
  if (completedReviews >= reviewSlots && !summaryClaimed) {
    const { eligible } = isAgentEligibleForRole(task.config, 'summary', agentId);
    if (!eligible) return null;
    return isSummaryAvailableForAgent(task, agentId) ? 'summary' : null;
  }

  return null;
}

/**
 * Throttle timeout checks to avoid O(n) KV scans on every poll request.
 * The last-check timestamp is stored in KV (via TaskStore) so it survives
 * isolate recycles. Note: the get-set sequence is not atomic, so concurrent
 * isolates may occasionally both pass the threshold — still far better than
 * checking on every poll.
 */
export const TIMEOUT_CHECK_INTERVAL_MS = 30_000;

/**
 * No-op — kept for backward compatibility with tests.
 * Throttle state is now stored in TaskStore, so fresh store creation
 * (or MemoryTaskStore.reset()) handles the reset.
 * @deprecated Use a fresh TaskStore instance instead.
 */
export function resetTimeoutThrottle(): void {
  // no-op — throttle state is now in TaskStore, not module-level
}

async function maybeCheckTimeouts(store: TaskStore, env: Env): Promise<void> {
  const now = Date.now();
  const lastCheck = await store.getTimeoutLastCheck();
  if (now - lastCheck < TIMEOUT_CHECK_INTERVAL_MS) return;
  await store.setTimeoutLastCheck(now);
  await checkTimeouts(store, env);
}

/**
 * Check for timed-out tasks and handle them.
 * Exported for use by the scheduled event handler (Cron Trigger).
 */
export async function checkTimeouts(store: TaskStore, env: Env): Promise<void> {
  const now = Date.now();
  const expired = await store.listTasks({
    status: ['pending', 'reviewing'],
    timeout_before: now,
  });

  for (const task of expired) {
    console.log(`Task ${task.id} timed out (PR #${task.pr_number} on ${task.owner}/${task.repo})`);

    // Post fallback: any completed reviews as individual comments
    const claims = await store.getClaims(task.id);

    // Log structured errors for each pending claim that timed out
    for (const claim of claims.filter((c) => c.status === 'pending')) {
      console.error(`[agent:${claim.agent_id}] task=${task.id} action=timeout role=${claim.role}`);
    }
    const completedReviews = claims.filter(
      (c) => c.role === 'review' && c.status === 'completed' && c.review_text,
    );

    try {
      const token = await getInstallationToken(task.github_installation_id, env);

      if (completedReviews.length > 0) {
        for (const claim of completedReviews) {
          const body = formatIndividualReviewComment(
            'unknown',
            'unknown',
            (claim.verdict as ReviewVerdict) ?? 'comment',
            claim.review_text!,
          );
          await postPrComment(task.owner, task.repo, task.pr_number, body, token);
        }
      }

      await postPrComment(
        task.owner,
        task.repo,
        task.pr_number,
        `**OpenCara**: Review timed out after ${Math.round((task.timeout_at - task.created_at) / 60000)} minutes.${completedReviews.length > 0 ? ` ${completedReviews.length} partial review(s) posted above.` : ''}`,
        token,
      );

      // Only mark timeout AFTER posting succeeds — if posting fails,
      // leave task in current state so next checkTimeouts() retries.
      await store.updateTask(task.id, { status: 'timeout' });
      await store.releaseSummaryLock(task.id);
    } catch (err) {
      console.error(
        `[task:${task.id}] action=timeout_post_failed error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/** Data passed directly from the result endpoint to avoid KV read-after-write staleness. */
export interface SummaryData {
  review_text: string;
  model?: string;
  tool?: string;
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
  store: TaskStore,
  env: Env,
  taskId: string,
  summaryAgentId: string,
  summaryData: SummaryData,
): Promise<void> {
  const task = await store.getTask(taskId);
  if (!task) return;

  // Defense-in-depth: if task is already completed, another agent already posted.
  // This prevents duplicate GitHub comments even if duplicate summary claims slip through.
  if (task.status === 'completed') {
    console.log(
      `Task ${taskId}: skipping duplicate post from ${summaryAgentId} — task already completed`,
    );
    return;
  }

  // Observability only: check if KV has propagated the write yet (does not affect review posting)
  const summaryClaim = await store.getClaim(`${taskId}:${summaryAgentId}`);
  if (!summaryClaim?.review_text) {
    console.warn(
      `Task ${taskId}: KV claim for ${summaryAgentId} returned stale data (no review_text) — using directly passed summary data`,
    );
  }

  const claims = await store.getClaims(taskId);

  try {
    const token = await getInstallationToken(task.github_installation_id, env);

    // Build agent info from claims
    const reviewClaims = claims.filter((c) => c.role === 'review' && c.status === 'completed');
    const reviewerAgents: ReviewAgentInfo[] = reviewClaims.map((c) => ({
      model: c.model ?? 'unknown',
      tool: c.tool ?? 'unknown',
    }));
    const synthAgent: ReviewAgentInfo = {
      model: summaryData.model ?? 'unknown',
      tool: summaryData.tool ?? 'unknown',
    };

    // Format the body — use summaryData.review_text directly (never re-read from KV)
    let body: string;
    if (task.review_count === 1) {
      // Single agent — post directly
      body = formatSummaryComment(summaryData.review_text, [], null);
    } else {
      // Multi-agent — include reviewer info in header
      body = formatSummaryComment(summaryData.review_text, reviewerAgents, synthAgent);
    }

    await postPrComment(task.owner, task.repo, task.pr_number, body, token);

    await store.updateTask(taskId, { status: 'completed' });
    await store.releaseSummaryLock(taskId);
    console.log(`Task ${taskId}: review posted to GitHub`);
  } catch (err) {
    console.error(
      `[agent:${summaryAgentId}] task=${taskId} action=post_review_failed error=${err instanceof Error ? err.message : String(err)}`,
    );
    await store.updateTask(taskId, { status: 'failed' });
    await store.releaseSummaryLock(taskId);
  }
}

/** Rate limit configs for task endpoints. */
export const POLL_RATE_LIMIT = { maxRequests: 12, windowMs: 60_000 };
export const MUTATION_RATE_LIMIT = { maxRequests: 30, windowMs: 60_000 };

export function taskRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  // ── Poll ─────────────────────────────────────────────────────

  app.post('/api/tasks/poll', rateLimitByAgent(POLL_RATE_LIMIT), async (c) => {
    const store = c.get('store');
    const body = await c.req.json<PollRequest>();
    const { agent_id, review_only, repos } = body;

    if (!agent_id) {
      return apiError(c, 400, 'INVALID_REQUEST', 'agent_id is required');
    }

    // Build a set of repos the agent declares for fast lookup
    const agentRepos = repos && repos.length > 0 ? new Set(repos) : null;

    // Update last-seen
    await store.setAgentLastSeen(agent_id, Date.now());

    // Check timeouts lazily (throttled to every 30s per isolate)
    await maybeCheckTimeouts(store, c.env);

    // Find available tasks
    const tasks = await store.listTasks({ status: ['pending', 'reviewing'] });
    const available: PollTask[] = [];

    for (const task of tasks) {
      // Private repo tasks: only return to agents declaring matching repos
      if (task.private && (!agentRepos || !agentRepos.has(`${task.owner}/${task.repo}`))) {
        continue;
      }

      const role = availableRole(task, agent_id);
      if (!role) continue;
      if (review_only && role === 'summary') continue;

      const remainingMs = task.timeout_at - Date.now();
      if (remainingMs <= 0) continue;

      available.push({
        task_id: task.id,
        owner: task.owner,
        repo: task.repo,
        pr_number: task.pr_number,
        diff_url: task.diff_url,
        timeout_seconds: Math.max(0, Math.floor(remainingMs / 1000)),
        prompt: task.prompt,
        role,
      });
    }

    return c.json<PollResponse>({ tasks: available });
  });

  // ── Claim ────────────────────────────────────────────────────

  app.post('/api/tasks/:taskId/claim', rateLimitByAgent(MUTATION_RATE_LIMIT), async (c) => {
    const store = c.get('store');
    const taskId = c.req.param('taskId');
    const body = await c.req.json<ClaimRequest>();
    const { agent_id, role, model, tool } = body;

    if (!agent_id || !role) {
      return apiError(c, 400, 'INVALID_REQUEST', 'agent_id and role are required');
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
    const eligibility = isAgentEligibleForRole(task.config, role, agent_id);
    if (!eligibility.eligible) {
      return apiError(
        c,
        409,
        'CLAIM_CONFLICT',
        eligibility.reason ?? 'Agent not eligible for this role',
      );
    }

    const actualRole = availableRole(task, agent_id);

    if (!actualRole || actualRole !== role) {
      return apiError(
        c,
        409,
        'CLAIM_CONFLICT',
        actualRole ? `Expected role ${actualRole}, got ${role}` : 'No slots available',
      );
    }

    // Acquire summary lock to prevent concurrent claims under KV eventual consistency.
    // Uses a dedicated KV key so only the first agent to write wins.
    if (role === 'summary') {
      const lockAcquired = await store.acquireSummaryLock(taskId, agent_id);
      if (!lockAcquired) {
        console.log(
          `Task ${taskId}: rejecting duplicate summary claim from ${agent_id} — lock held by another agent`,
        );
        return apiError(c, 409, 'SUMMARY_LOCKED', 'Summary already claimed by another agent');
      }
    }

    // Create the claim
    const claimId = `${taskId}:${agent_id}`;
    await store.createClaim({
      id: claimId,
      task_id: taskId,
      agent_id,
      role,
      status: 'pending',
      model,
      tool,
      created_at: Date.now(),
    });

    // Update task counters atomically (avoids KV list consistency issues)
    const claimedAgents = task.claimed_agents ?? [];
    if (!claimedAgents.includes(agent_id)) {
      claimedAgents.push(agent_id);
    }
    const taskUpdates: Partial<ReviewTask> = {
      claimed_agents: claimedAgents,
      status: task.status === 'pending' ? 'reviewing' : task.status,
    };
    if (role === 'review') {
      taskUpdates.review_claims = (task.review_claims ?? 0) + 1;
    } else {
      taskUpdates.summary_claimed = true;
    }
    await store.updateTask(taskId, taskUpdates);

    // If summary role, include completed review texts (use getClaims here — OK since
    // reviews were completed in prior requests, KV has had time to propagate)
    if (role === 'summary') {
      const claims = await store.getClaims(taskId);
      const completedReviews = claims
        .filter((c) => c.role === 'review' && c.status === 'completed' && c.review_text)
        .map((c) => ({
          agent_id: c.agent_id,
          review_text: c.review_text!,
          verdict: (c.verdict ?? 'comment') as ReviewVerdict,
        }));
      return c.json<ClaimResponse>({ claimed: true, reviews: completedReviews });
    }

    return c.json<ClaimResponse>({ claimed: true });
  });

  // ── Result ───────────────────────────────────────────────────

  app.post('/api/tasks/:taskId/result', rateLimitByAgent(MUTATION_RATE_LIMIT), async (c) => {
    const store = c.get('store');
    const taskId = c.req.param('taskId');
    const body = await c.req.json<ResultRequest>();
    const { agent_id, type, review_text, verdict, tokens_used } = body;

    if (!agent_id || !type || !review_text) {
      return apiError(c, 400, 'INVALID_REQUEST', 'agent_id, type, and review_text are required');
    }

    const claimId = `${taskId}:${agent_id}`;
    const claim = await store.getClaim(claimId);

    if (!claim) {
      console.error(`[agent:${agent_id}] task=${taskId} action=result_rejected reason=no_claim`);
      return apiError(c, 404, 'CLAIM_NOT_FOUND', 'No claim found for this agent on this task');
    }

    if (claim.status !== 'pending') {
      console.error(
        `[agent:${agent_id}] task=${taskId} action=result_rejected reason=claim_${claim.status}`,
      );
      return apiError(c, 409, 'CLAIM_CONFLICT', `Claim already ${claim.status}`);
    }

    if (claim.role !== type) {
      console.error(
        `[agent:${agent_id}] task=${taskId} action=result_rejected reason=role_mismatch claim_role=${claim.role} submission_type=${type}`,
      );
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
      // Verify this agent holds the summary lock before posting to GitHub.
      // Under concurrent claims, multiple agents may have claimed summary,
      // but only the lock holder should post the review.
      const holdsLock = await store.checkSummaryLock(taskId, agent_id);
      if (!holdsLock) {
        console.log(
          `Task ${taskId}: accepting result from ${agent_id} but skipping GitHub post — agent does not hold summary lock`,
        );
        return c.json<ResultResponse>({ success: true });
      }

      // Summary submitted — post the final review to GitHub
      // Pass data directly to avoid KV read-after-write staleness
      await postFinalReview(store, c.env, taskId, agent_id, {
        review_text,
        model: claim.model,
        tool: claim.tool,
      });
    } else {
      // Review submitted — increment completed_reviews counter on task
      const newCompleted = (task.completed_reviews ?? 0) + 1;
      const taskUpdates: Partial<ReviewTask> = { completed_reviews: newCompleted };

      const reviewSlots = task.review_count > 1 ? task.review_count - 1 : 0;
      if (reviewSlots > 0 && newCompleted >= reviewSlots) {
        // Set reviews_completed_at for preferred synthesizer grace period
        taskUpdates.reviews_completed_at = Date.now();
        console.log(
          `Task ${taskId}: all ${reviewSlots} reviews complete, summary slot now available`,
        );
      }
      await store.updateTask(taskId, taskUpdates);
    }

    return c.json<ResultResponse>({ success: true });
  });

  // ── Reject ───────────────────────────────────────────────────

  app.post('/api/tasks/:taskId/reject', rateLimitByAgent(MUTATION_RATE_LIMIT), async (c) => {
    const store = c.get('store');
    const taskId = c.req.param('taskId');
    const body = await c.req.json<RejectRequest>();
    const { agent_id, reason } = body;

    const claimId = `${taskId}:${agent_id}`;
    const claim = await store.getClaim(claimId);

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

    await store.updateClaim(claimId, { status: 'rejected' });

    // Free the slot so another agent can claim it
    const task = await store.getTask(taskId);
    if (task) {
      const updates: Partial<ReviewTask> = {
        claimed_agents: (task.claimed_agents ?? []).filter((id) => id !== agent_id),
      };
      if (claim.role === 'review') {
        updates.review_claims = Math.max(0, (task.review_claims ?? 0) - 1);
      } else if (claim.role === 'summary') {
        updates.summary_claimed = false;
        await store.releaseSummaryLock(taskId);
      }
      await store.updateTask(taskId, updates);
    }

    console.error(
      `[agent:${agent_id}] task=${taskId} action=reject role=${claim.role} reason=${reason ?? 'none'}`,
    );
    return c.json({ success: true });
  });

  // ── Error ────────────────────────────────────────────────────

  app.post('/api/tasks/:taskId/error', rateLimitByAgent(MUTATION_RATE_LIMIT), async (c) => {
    const store = c.get('store');
    const taskId = c.req.param('taskId');
    const body = await c.req.json<ErrorRequest>();
    const { agent_id, error } = body;

    const claimId = `${taskId}:${agent_id}`;
    const claim = await store.getClaim(claimId);

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

    await store.updateClaim(claimId, { status: 'error' });

    // Free the slot so another agent can claim it
    const task = await store.getTask(taskId);
    if (task) {
      const updates: Partial<ReviewTask> = {
        claimed_agents: (task.claimed_agents ?? []).filter((id) => id !== agent_id),
      };
      if (claim.role === 'review') {
        updates.review_claims = Math.max(0, (task.review_claims ?? 0) - 1);
      } else if (claim.role === 'summary') {
        updates.summary_claimed = false;
        await store.releaseSummaryLock(taskId);
      }
      await store.updateTask(taskId, updates);
    }

    console.error(
      `[agent:${agent_id}] task=${taskId} action=error role=${claim.role} error=${error ?? 'unknown'}`,
    );
    return c.json({ success: true });
  });

  return app;
}
