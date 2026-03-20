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
  TaskClaim,
} from '@opencara/shared';
import type { Env } from '../types.js';
import type { TaskStore } from '../store/interface.js';
import { getInstallationToken } from '../github/app.js';
import { postPrReview, postPrComment, verdictToReviewEvent } from '../github/reviews.js';
import { parseStructuredReview, parseDiffFiles, filterValidComments } from '../review-parser.js';
import {
  formatSummaryComment,
  formatIndividualReviewComment,
  type ReviewAgentInfo,
} from '../review-formatter.js';

/**
 * Determine the available role for an agent on a task.
 * Returns null if no role is available.
 */
function availableRole(
  reviewCount: number,
  claims: TaskClaim[],
  agentId: string,
): ClaimRole | null {
  // Agent already has a claim on this task
  if (claims.some((c) => c.agent_id === agentId)) return null;

  const reviewClaims = claims.filter((c) => c.role === 'review');
  const summaryClaims = claims.filter((c) => c.role === 'summary');

  if (reviewCount === 1) {
    // Single-agent: one summary slot only
    if (summaryClaims.length === 0) return 'summary';
    return null;
  }

  // Multi-agent: reviewCount-1 review slots, then 1 summary slot
  const reviewSlots = reviewCount - 1;
  if (reviewClaims.length < reviewSlots) return 'review';

  // Summary available only after all reviews are completed
  const completedReviews = reviewClaims.filter((c) => c.status === 'completed');
  if (completedReviews.length >= reviewSlots && summaryClaims.length === 0) return 'summary';

  return null;
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
    } catch (err) {
      console.error(`Failed to post timeout comment for task ${task.id}:`, err);
    }

    await store.updateTask(task.id, { status: 'timeout' });
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
    const verdict =
      parsed.verdict ?? (summaryClaim.verdict as ReviewVerdict | undefined) ?? 'comment';

    // Try to fetch diff for comment validation (best effort)
    let validComments = parsed.comments;
    try {
      // Fetch diff from GitHub for comment path validation
      const diffResponse = await fetch(
        `https://api.github.com/repos/${task.owner}/${task.repo}/pulls/${task.pr_number}`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: 'application/vnd.github.diff',
            'User-Agent': 'OpenCara-Server',
            'X-GitHub-Api-Version': '2022-11-28',
          },
        },
      );
      if (diffResponse.ok) {
        const diffContent = await diffResponse.text();
        const diffFiles = parseDiffFiles(diffContent);
        validComments = filterValidComments(parsed.comments, diffFiles);
      }
    } catch {
      // Skip comment filtering if diff fetch fails
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
    console.error(`Failed to post review for task ${taskId}:`, err);
    await store.updateTask(taskId, { status: 'failed' });
  }
}

export function taskRoutes(store: TaskStore) {
  const app = new Hono<{ Bindings: Env }>();

  // ── Poll ─────────────────────────────────────────────────────

  app.post('/api/tasks/poll', async (c) => {
    const body = await c.req.json<PollRequest>();
    const { agent_id } = body;

    if (!agent_id) {
      return c.json({ error: 'agent_id is required' }, 400);
    }

    // Update last-seen
    await store.setAgentLastSeen(agent_id, Date.now());

    // Check timeouts lazily
    await checkTimeouts(store, c.env);

    // Find available tasks
    const tasks = await store.listTasks({ status: ['pending', 'reviewing'] });
    const available: PollTask[] = [];

    for (const task of tasks) {
      const claims = await store.getClaims(task.id);
      const role = availableRole(task.review_count, claims, agent_id);
      if (!role) continue;

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

    const claims = await store.getClaims(taskId);
    const actualRole = availableRole(task.review_count, claims, agent_id);

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

    // Update task status to reviewing
    if (task.status === 'pending') {
      await store.updateTask(taskId, { status: 'reviewing' });
    }

    // If summary role, include completed review texts
    if (role === 'summary') {
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
    const taskId = c.req.param('taskId');
    const body = await c.req.json<ResultRequest>();
    const { agent_id, type, review_text, verdict, tokens_used } = body;

    if (!agent_id || !type || !review_text) {
      return c.json({ error: 'agent_id, type, and review_text are required' }, 400);
    }

    const claimId = `${taskId}:${agent_id}`;
    const claim = await store.getClaim(claimId);

    if (!claim) {
      return c.json({ error: 'No claim found for this agent on this task' }, 404);
    }

    if (claim.status !== 'pending') {
      return c.json({ error: `Claim already ${claim.status}` }, 409);
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
      // Review submitted — check if summary slot just became available
      const updatedClaims = await store.getClaims(taskId);
      const reviewSlots = task.review_count > 1 ? task.review_count - 1 : 0;
      const completedReviews = updatedClaims.filter(
        (cl) => cl.role === 'review' && cl.status === 'completed',
      );

      if (task.review_count === 1 && completedReviews.length === 0) {
        // Single-agent mode doesn't have review claims, only summary
      }

      // If all review slots are filled, the summary slot is now available
      // (agents will pick it up on next poll)
      if (reviewSlots > 0 && completedReviews.length >= reviewSlots) {
        console.log(
          `Task ${taskId}: all ${reviewSlots} reviews complete, summary slot now available`,
        );
      }
    }

    return c.json<ResultResponse>({ success: true });
  });

  // ── Reject ───────────────────────────────────────────────────

  app.post('/api/tasks/:taskId/reject', async (c) => {
    const taskId = c.req.param('taskId');
    const body = await c.req.json<RejectRequest>();
    const { agent_id, reason } = body;

    const claimId = `${taskId}:${agent_id}`;
    await store.updateClaim(claimId, { status: 'rejected' });
    console.log(`Task ${taskId}: agent ${agent_id} rejected — ${reason}`);

    return c.json({ success: true });
  });

  // ── Error ────────────────────────────────────────────────────

  app.post('/api/tasks/:taskId/error', async (c) => {
    const taskId = c.req.param('taskId');
    const body = await c.req.json<ErrorRequest>();
    const { agent_id, error } = body;

    const claimId = `${taskId}:${agent_id}`;
    await store.updateClaim(claimId, { status: 'error' });
    console.error(`Task ${taskId}: agent ${agent_id} error — ${error}`);

    return c.json({ success: true });
  });

  return app;
}
