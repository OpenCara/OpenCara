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
import { githubFetch } from '../github/fetch.js';
import { postPrReview, postPrComment, verdictToReviewEvent } from '../github/reviews.js';
import { parseStructuredReview, parseDiffFiles, filterValidComments } from '../review-parser.js';
import {
  formatSummaryComment,
  formatIndividualReviewComment,
  type ReviewAgentInfo,
} from '../review-formatter.js';

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
    if (!summaryClaimed) return 'summary';
    return null;
  }

  const reviewSlots = task.review_count - 1;
  if (reviewClaims < reviewSlots) return 'review';
  if (completedReviews >= reviewSlots && !summaryClaimed) return 'summary';

  return null;
}

/**
 * Throttle timeout checks to avoid O(n) KV scans on every poll request.
 * In Workers, global state persists within an isolate but not across isolates.
 * Worst case: multiple isolates each check once per interval — still far better than every poll.
 */
let lastTimeoutCheck = 0;
const TIMEOUT_CHECK_INTERVAL_MS = 30_000;

/** Exported for testing — reset the throttle state. */
export function resetTimeoutThrottle(): void {
  lastTimeoutCheck = 0;
}

async function maybeCheckTimeouts(store: TaskStore, env: Env): Promise<void> {
  const now = Date.now();
  if (now - lastTimeoutCheck < TIMEOUT_CHECK_INTERVAL_MS) return;
  lastTimeoutCheck = now;
  await checkTimeouts(store, env);
}

/**
 * Check for timed-out tasks and handle them.
 */
async function checkTimeouts(store: TaskStore, env: Env): Promise<void> {
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
          await postPrReview(
            task.owner,
            task.repo,
            task.pr_number,
            body,
            verdictToReviewEvent((claim.verdict as ReviewVerdict) ?? 'comment'),
            token,
          );
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
    } catch (err) {
      console.error(
        `[task:${task.id}] action=timeout_post_failed error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

/**
 * Post the final review to GitHub when a task is complete.
 * For summary role: post the synthesized/single review with inline comments.
 */
async function postFinalReview(
  store: TaskStore,
  env: Env,
  taskId: string,
  summaryAgentId: string,
): Promise<void> {
  const task = await store.getTask(taskId);
  if (!task) return;

  // Use direct getClaim (KV get) instead of getClaims (KV list) to avoid
  // eventual consistency issues — the claim was just updated moments ago.
  const summaryClaim = await store.getClaim(`${taskId}:${summaryAgentId}`);
  if (!summaryClaim?.review_text) return;

  const claims = await store.getClaims(taskId);

  try {
    const token = await getInstallationToken(task.github_installation_id, env);

    // Parse the review for inline comments
    const parsed = parseStructuredReview(summaryClaim.review_text);

    // Build agent info from claims
    const reviewClaims = claims.filter((c) => c.role === 'review' && c.status === 'completed');
    const reviewerAgents: ReviewAgentInfo[] = reviewClaims.map((c) => ({
      model: c.model ?? 'unknown',
      tool: c.tool ?? 'unknown',
    }));
    const synthAgent: ReviewAgentInfo = {
      model: summaryClaim.model ?? 'unknown',
      tool: summaryClaim.tool ?? 'unknown',
    };

    // Format the body
    let body: string;
    if (task.review_count === 1) {
      // Single agent — post directly
      body = formatSummaryComment(summaryClaim.review_text, [], null);
    } else {
      // Multi-agent — include reviewer info in header
      body = formatSummaryComment(summaryClaim.review_text, reviewerAgents, synthAgent);
    }

    // Determine verdict and inline comments
    // Normalize to lowercase — agents may submit uppercase verdicts (e.g. "APPROVE")
    const rawVerdict =
      parsed.verdict ?? (summaryClaim.verdict as ReviewVerdict | undefined) ?? 'comment';
    const verdict = (
      typeof rawVerdict === 'string' ? rawVerdict.toLowerCase() : rawVerdict
    ) as ReviewVerdict;

    // Try to fetch diff for comment validation (best effort)
    let validComments = parsed.comments;
    try {
      // Fetch diff from GitHub for comment path validation
      const diffResponse = await githubFetch(
        `https://api.github.com/repos/${task.owner}/${task.repo}/pulls/${task.pr_number}`,
        {
          token,
          accept: 'application/vnd.github.diff',
        },
      );
      if (diffResponse.ok) {
        const diffContent = await diffResponse.text();
        const diffFiles = parseDiffFiles(diffContent);
        validComments = filterValidComments(parsed.comments, diffFiles);
      } else {
        console.warn(
          `[agent:${summaryAgentId}] task=${taskId} action=diff_fetch_failed status=${diffResponse.status}`,
        );
      }
    } catch (err) {
      console.warn(
        `[agent:${summaryAgentId}] task=${taskId} action=diff_fetch_failed error=${err instanceof Error ? err.message : String(err)}`,
      );
    }

    await postPrReview(
      task.owner,
      task.repo,
      task.pr_number,
      body,
      verdictToReviewEvent(verdict),
      token,
      validComments.length > 0 ? validComments : undefined,
    );

    await store.updateTask(taskId, { status: 'completed' });
    console.log(`Task ${taskId}: review posted to GitHub`);
  } catch (err) {
    console.error(
      `[agent:${summaryAgentId}] task=${taskId} action=post_review_failed error=${err instanceof Error ? err.message : String(err)}`,
    );
    await store.updateTask(taskId, { status: 'failed' });
  }
}

export function taskRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  // ── Poll ─────────────────────────────────────────────────────

  app.post('/api/tasks/poll', async (c) => {
    const store = c.get('store');
    const body = await c.req.json<PollRequest>();
    const { agent_id, review_only } = body;

    if (!agent_id) {
      return c.json({ error: 'agent_id is required' }, 400);
    }

    // Update last-seen
    await store.setAgentLastSeen(agent_id, Date.now());

    // Check timeouts lazily (throttled to every 30s per isolate)
    await maybeCheckTimeouts(store, c.env);

    // Find available tasks
    const tasks = await store.listTasks({ status: ['pending', 'reviewing'] });
    const available: PollTask[] = [];

    for (const task of tasks) {
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

  app.post('/api/tasks/:taskId/claim', async (c) => {
    const store = c.get('store');
    const taskId = c.req.param('taskId');
    const body = await c.req.json<ClaimRequest>();
    const { agent_id, role, model, tool } = body;

    if (!agent_id || !role) {
      return c.json({ error: 'agent_id and role are required' }, 400);
    }

    const task = await store.getTask(taskId);
    if (!task) {
      return c.json<ClaimResponse>({ claimed: false, reason: 'Task not found' });
    }

    if (task.status !== 'pending' && task.status !== 'reviewing') {
      return c.json<ClaimResponse>({ claimed: false, reason: `Task is ${task.status}` });
    }

    if (task.timeout_at <= Date.now()) {
      return c.json<ClaimResponse>({ claimed: false, reason: 'Task has timed out' });
    }

    const actualRole = availableRole(task, agent_id);

    if (!actualRole || actualRole !== role) {
      return c.json<ClaimResponse>({
        claimed: false,
        reason: actualRole ? `Expected role ${actualRole}, got ${role}` : 'No slots available',
      });
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

  app.post('/api/tasks/:taskId/result', async (c) => {
    const store = c.get('store');
    const taskId = c.req.param('taskId');
    const body = await c.req.json<ResultRequest>();
    const { agent_id, type, review_text, verdict, tokens_used } = body;

    if (!agent_id || !type || !review_text) {
      return c.json({ error: 'agent_id, type, and review_text are required' }, 400);
    }

    const claimId = `${taskId}:${agent_id}`;
    const claim = await store.getClaim(claimId);

    if (!claim) {
      console.error(`[agent:${agent_id}] task=${taskId} action=result_rejected reason=no_claim`);
      return c.json({ error: 'No claim found for this agent on this task' }, 404);
    }

    if (claim.status !== 'pending') {
      console.error(
        `[agent:${agent_id}] task=${taskId} action=result_rejected reason=claim_${claim.status}`,
      );
      return c.json({ error: `Claim already ${claim.status}` }, 409);
    }

    if (claim.role !== type) {
      console.error(
        `[agent:${agent_id}] task=${taskId} action=result_rejected reason=role_mismatch claim_role=${claim.role} submission_type=${type}`,
      );
      return c.json(
        { error: `Claim role '${claim.role}' does not match submission type '${type}'` },
        400,
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
      // Summary submitted — post the final review to GitHub
      await postFinalReview(store, c.env, taskId, agent_id);
    } else {
      // Review submitted — increment completed_reviews counter on task
      const newCompleted = (task.completed_reviews ?? 0) + 1;
      await store.updateTask(taskId, { completed_reviews: newCompleted });

      const reviewSlots = task.review_count > 1 ? task.review_count - 1 : 0;
      if (reviewSlots > 0 && newCompleted >= reviewSlots) {
        console.log(
          `Task ${taskId}: all ${reviewSlots} reviews complete, summary slot now available`,
        );
      }
    }

    return c.json<ResultResponse>({ success: true });
  });

  // ── Reject ───────────────────────────────────────────────────

  app.post('/api/tasks/:taskId/reject', async (c) => {
    const store = c.get('store');
    const taskId = c.req.param('taskId');
    const body = await c.req.json<RejectRequest>();
    const { agent_id, reason } = body;

    const claimId = `${taskId}:${agent_id}`;
    const claim = await store.getClaim(claimId);

    if (!claim) {
      return c.json({ error: 'Claim not found' }, 404);
    }

    if (claim.status !== 'pending') {
      // Idempotent: already rejected → return 200
      if (claim.status === 'rejected') {
        return c.json({ success: true });
      }
      return c.json({ error: `Claim is ${claim.status}, expected pending` }, 409);
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
      }
      await store.updateTask(taskId, updates);
    }

    console.error(
      `[agent:${agent_id}] task=${taskId} action=reject role=${claim.role} reason=${reason ?? 'none'}`,
    );
    return c.json({ success: true });
  });

  // ── Error ────────────────────────────────────────────────────

  app.post('/api/tasks/:taskId/error', async (c) => {
    const store = c.get('store');
    const taskId = c.req.param('taskId');
    const body = await c.req.json<ErrorRequest>();
    const { agent_id, error } = body;

    const claimId = `${taskId}:${agent_id}`;
    const claim = await store.getClaim(claimId);

    if (!claim) {
      return c.json({ error: 'Claim not found' }, 404);
    }

    if (claim.status !== 'pending') {
      // Idempotent: already errored → return 200
      if (claim.status === 'error') {
        return c.json({ success: true });
      }
      return c.json({ error: `Claim is ${claim.status}, expected pending` }, 409);
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
