import { Hono } from 'hono';
import type {
  PollResponse,
  PollTask,
  ClaimResponse,
  ClaimReview,
  ResultResponse,
  ReviewVerdict,
  ReviewTask,
  TaskRole,
  DedupReport,
  TriageReport,
  ImplementReport,
  FixReport,
  BatchPollResponse,
  RepoConfig,
} from '@opencara/shared';
import { isRepoAllowed, isEntityMatch, isDedupRole } from '@opencara/shared';
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
import { evaluateSummaryQuality, MAX_SUMMARY_RETRIES } from '../summary-evaluator.js';
import { isAgentEligibleForRole } from '../eligibility.js';
import { rateLimitByAgent, rateLimitByIP } from '../middleware/rate-limit.js';
import { requireOAuth } from '../middleware/oauth.js';
import { apiError } from '../errors.js';
import {
  isTaskActive,
  isWorkerTask,
  isSummaryTask,
  isClaimPending,
  isClaimFailed,
  isCompletedReview,
} from '../task-lifecycle.js';
import { appendOpenEntry, fetchIndexBody } from '../dedup-index.js';
import {
  parseBody,
  PollRequestSchema,
  BatchPollRequestSchema,
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

/** Grace period (ms) for target_model preference (implement/fix tasks). */
export const TARGET_MODEL_GRACE_PERIOD_MS = 120_000;

/**
 * Check if an agent's model/tool matches the review preferences in the config.
 * Returns true if no preferences are set (backward compatible) or if the agent matches.
 */
function isReviewPreferredAgent(
  config: ReviewTask['config'],
  model?: string,
  tool?: string,
): boolean {
  const { preferredModels, preferredTools } = config;
  if (preferredModels.length === 0 && preferredTools.length === 0) return true;
  if (model && preferredModels.includes(model)) return true;
  if (tool && preferredTools.includes(tool)) return true;
  return false;
}

/**
 * Check if a worker task is visible to the given agent, considering
 * the preferred model/tool grace period.
 */
function isWorkerVisibleToAgent(task: ReviewTask, model?: string, tool?: string): boolean {
  if (isReviewPreferredAgent(task.config, model, tool)) return true;
  return Date.now() - task.created_at >= PREFERRED_REVIEW_GRACE_PERIOD_MS;
}

/**
 * Check if a task with target_model is visible to the given agent.
 * During the grace period, only agents matching the target model can see the task.
 * After the grace period, any agent can claim it.
 */
function isTargetModelVisible(task: ReviewTask, model?: string): boolean {
  if (!task.target_model) return true; // no preference — visible to all
  if (model && model.toLowerCase() === task.target_model.toLowerCase()) return true; // model matches
  return Date.now() - task.created_at >= TARGET_MODEL_GRACE_PERIOD_MS;
}

/**
 * Check if a task is visible to the given agent considering model diversity.
 * During the grace window, hides tasks from agents whose model is already
 * used by another claim in the same group. After the grace window, visible to all.
 */
function isModelDiversityVisible(
  task: ReviewTask,
  model: string | undefined,
  groupClaimedModels: Map<string, Set<string>>,
): boolean {
  const graceMs = task.config.modelDiversityGraceMs;
  if (graceMs <= 0) return true; // diversity disabled
  if (!model) return true; // agent didn't declare a model, can't check
  if (!task.group_id) return true; // no group, no diversity to enforce

  const claimedModels = groupClaimedModels.get(task.group_id);
  if (!claimedModels || !claimedModels.has(model)) return true; // model not yet used

  // Model already used — check if grace period has elapsed
  return Date.now() - task.created_at >= graceMs;
}

/**
 * Check if a summary task is visible to the given agent, considering
 * the preferred synthesizer grace period.
 * Checks both entity-based preferences and model-based preferences.
 */
function isSummaryVisibleToAgent(task: ReviewTask, agentId: string, model?: string): boolean {
  const summarizer = task.config?.summarizer;
  const preferred = summarizer?.preferred ?? [];
  const preferredModels = summarizer?.preferredModels ?? [];

  // No preferences at all — visible to everyone
  if (preferred.length === 0 && preferredModels.length === 0) return true;

  // Check entity-based preference
  if (preferred.length > 0 && preferred.some((p) => isEntityMatch(p, agentId))) return true;

  // Check model-based preference
  if (preferredModels.length > 0 && model && preferredModels.includes(model)) return true;

  // Non-preferred agent: check if grace period has elapsed since summary phase started.
  // Use reviews_completed_at (when all reviews finished and summary became claimable)
  // with fallback to created_at for single-agent tasks that skip the review phase.
  const summaryPhaseStart = task.reviews_completed_at ?? task.created_at;
  return Date.now() - summaryPhaseStart >= PREFERRED_SYNTH_GRACE_PERIOD_MS;
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

  // Track which groups we've already processed to avoid duplicate posts
  const processedGroups = new Set<string>();

  for (const task of expired) {
    // If this task is part of a group, handle the entire group at once
    if (task.group_id && processedGroups.has(task.group_id)) {
      continue;
    }

    log.info('Task timed out', {
      taskId: task.id,
      owner: task.owner,
      repo: task.repo,
      prNumber: task.pr_number,
    });

    if (task.group_id) {
      processedGroups.add(task.group_id);

      // Collect completed reviews from ALL worker tasks in the group
      const groupTasks = await store.getTasksByGroup(task.group_id);
      const allReviews: TimeoutReview[] = [];

      for (const gt of groupTasks) {
        const claims = await store.getClaims(gt.id);

        // Log structured errors for pending claims that timed out
        for (const claim of claims.filter(isClaimPending)) {
          log.error('Agent claim timed out', {
            agentId: claim.agent_id,
            taskId: gt.id,
            action: 'timeout',
            role: claim.role,
          });
        }

        // Collect completed reviews from this task
        const completedReviews = claims.filter(isCompletedReview);
        for (const claim of completedReviews) {
          allReviews.push({
            model: claim.model ?? 'unknown',
            tool: claim.tool ?? 'unknown',
            thinking: claim.thinking,
            verdict: (claim.verdict as ReviewVerdict) ?? 'comment',
            review_text: claim.review_text!,
          });
        }
      }

      try {
        const token = await github.getInstallationToken(task.github_installation_id);
        const timeoutMinutes = Math.round((task.timeout_at - task.created_at) / 60000);
        const body = formatTimeoutComment(timeoutMinutes, allReviews);
        await github.postPrComment(task.owner, task.repo, task.pr_number, body, token);
        await store.deleteTasksByGroup(task.group_id);
      } catch (err) {
        log.error('Timeout post failed', {
          taskId: task.id,
          groupId: task.group_id,
          action: 'timeout_post_failed',
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      // Non-group task: handle individually (legacy path)
      const claims = await store.getClaims(task.id);

      for (const claim of claims.filter(isClaimPending)) {
        log.error('Agent claim timed out', {
          agentId: claim.agent_id,
          taskId: task.id,
          action: 'timeout',
          role: claim.role,
        });
      }
      const completedReviews = claims.filter(isCompletedReview);

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
}

/** Data passed directly from the result endpoint to avoid KV read-after-write staleness. */
export interface SummaryData {
  review_text: string;
}

// ── Summary Result Handlers (dispatch by feature) ──────────────

/**
 * Post the final review to GitHub when a review summary is complete.
 */
async function handleReviewSummaryResult(
  store: DataStore,
  github: GitHubService,
  task: ReviewTask,
  groupId: string,
  summaryData: SummaryData,
  logger: Logger,
): Promise<void> {
  const trimmed = summaryData.review_text.trim();
  if (trimmed.length < REVIEW_TEXT_MIN_LENGTH) {
    logger.error('Final review guard — review_text too short, skipping GitHub post', {
      taskId: task.id,
      length: trimmed.length,
    });
    return;
  }

  // Collect unique contributors from all claims in the group
  let contributors: string[] = [];
  try {
    const groupTasks = await store.getTasksByGroup(groupId);
    for (const gt of groupTasks) {
      const claims = await store.getClaims(gt.id);
      for (const c of claims) {
        if (c.github_username) contributors.push(c.github_username);
      }
    }
    contributors = [...new Set(contributors)];
  } catch {
    // Non-fatal — post review without contributor attribution
  }

  const token = await github.getInstallationToken(task.github_installation_id);
  const body = wrapReviewComment(trimmed, contributors.length > 0 ? contributors : undefined);
  await github.postPrComment(task.owner, task.repo, task.pr_number, body, token);

  logger.info('Review posted to GitHub', {
    taskId: task.id,
    owner: task.owner,
    repo: task.repo,
    prNumber: task.pr_number,
  });
}

/**
 * Handle dedup summary result — post comment on PR/issue + update index issue.
 */
async function handleDedupSummaryResult(
  store: DataStore,
  github: GitHubService,
  task: ReviewTask,
  groupId: string,
  dedupReport: DedupReport | undefined,
  reviewText: string,
  logger: Logger,
): Promise<void> {
  const token = await github.getInstallationToken(task.github_installation_id);
  const commentBody = wrapReviewComment(reviewText.trim());

  if (task.task_type === 'pr_dedup' && task.pr_number > 0) {
    // Post comment on the PR
    await github.postPrComment(task.owner, task.repo, task.pr_number, commentBody, token);
    logger.info('Dedup PR comment posted', {
      taskId: task.id,
      prNumber: task.pr_number,
    });
  } else if (task.task_type === 'issue_dedup' && task.issue_number) {
    // Post comment on the issue
    await github.postPrComment(task.owner, task.repo, task.issue_number, commentBody, token);
    logger.info('Dedup issue comment posted', {
      taskId: task.id,
      issueNumber: task.issue_number,
    });
  }

  // Update the index issue if configured and report includes an index entry
  if (dedupReport?.index_entry && task.index_issue_number) {
    try {
      await appendOpenEntry(
        github,
        task.owner,
        task.repo,
        task.index_issue_number,
        dedupReport.index_entry,
        token,
        logger,
      );
      logger.info('Index issue updated (structured comments)', {
        taskId: task.id,
        indexIssue: task.index_issue_number,
      });
    } catch (err) {
      logger.error('Failed to update index issue', {
        taskId: task.id,
        indexIssue: task.index_issue_number,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

/**
 * Handle triage summary result — comment or rewrite issue + apply labels.
 */
async function handleTriageSummaryResult(
  _store: DataStore,
  github: GitHubService,
  task: ReviewTask,
  _groupId: string,
  triageReport: TriageReport | undefined,
  reviewText: string,
  logger: Logger,
): Promise<void> {
  if (!task.issue_number) {
    logger.error('Triage result but no issue_number on task', { taskId: task.id });
    return;
  }

  const token = await github.getInstallationToken(task.github_installation_id);

  if (triageReport) {
    // Determine mode: rewrite or comment
    const triageConfig = task.config as unknown as {
      defaultMode?: string;
      authorModes?: Record<string, string>;
    };
    let mode: 'comment' | 'rewrite' = 'comment';
    if (triageConfig.defaultMode === 'rewrite') mode = 'rewrite';
    if (task.issue_author && triageConfig.authorModes?.[task.issue_author]) {
      mode = triageConfig.authorModes[task.issue_author] as 'comment' | 'rewrite';
    }

    if (mode === 'rewrite' && triageReport.body) {
      // Rewrite the issue body
      const updates: { body?: string; title?: string; labels?: string[] } = {
        body: triageReport.body,
      };
      if (triageReport.summary) {
        updates.title = triageReport.summary;
      }
      if (triageReport.labels.length > 0) {
        updates.labels = triageReport.labels;
      }
      await github.updateIssue(task.owner, task.repo, task.issue_number, updates, token);
      logger.info('Triage issue rewritten', {
        taskId: task.id,
        issueNumber: task.issue_number,
        mode: 'rewrite',
      });
    } else {
      // Post comment on the issue
      const commentBody = wrapReviewComment(triageReport.comment || reviewText.trim());
      await github.postPrComment(task.owner, task.repo, task.issue_number, commentBody, token);

      // Apply labels if configured
      if (triageReport.labels.length > 0) {
        await github.updateIssue(
          task.owner,
          task.repo,
          task.issue_number,
          { labels: triageReport.labels },
          token,
        );
      }
      logger.info('Triage comment posted', {
        taskId: task.id,
        issueNumber: task.issue_number,
        mode: 'comment',
        labels: triageReport.labels,
      });
    }
  } else {
    // No structured report — just post review text as a comment
    const commentBody = wrapReviewComment(reviewText.trim());
    await github.postPrComment(task.owner, task.repo, task.issue_number, commentBody, token);
    logger.info('Triage fallback comment posted', {
      taskId: task.id,
      issueNumber: task.issue_number,
    });
  }
}

/**
 * Handle implement summary result — post comment on the issue with the implementation summary.
 */
async function handleImplementSummaryResult(
  _store: DataStore,
  github: GitHubService,
  task: ReviewTask,
  _groupId: string,
  implementReport: ImplementReport | undefined,
  reviewText: string,
  logger: Logger,
): Promise<void> {
  if (!task.issue_number) {
    throw new Error(`Implement result but no issue_number on task ${task.id}`);
  }

  const token = await github.getInstallationToken(task.github_installation_id);
  const commentBody = wrapReviewComment(reviewText.trim());
  await github.postPrComment(task.owner, task.repo, task.issue_number, commentBody, token);

  logger.info('Implement result posted to GitHub', {
    taskId: task.id,
    owner: task.owner,
    repo: task.repo,
    issueNumber: task.issue_number,
    branch: implementReport?.branch,
    prNumber: implementReport?.pr_number,
  });
}

/**
 * Handle fix summary result — post comment on the PR with the fix summary.
 */
async function handleFixSummaryResult(
  _store: DataStore,
  github: GitHubService,
  task: ReviewTask,
  _groupId: string,
  fixReport: FixReport | undefined,
  reviewText: string,
  logger: Logger,
): Promise<void> {
  if (task.pr_number <= 0) {
    throw new Error(`Fix result but no pr_number on task ${task.id}`);
  }

  const token = await github.getInstallationToken(task.github_installation_id);
  const commentBody = wrapReviewComment(reviewText.trim());
  await github.postPrComment(task.owner, task.repo, task.pr_number, commentBody, token);

  logger.info('Fix result posted to PR', {
    taskId: task.id,
    owner: task.owner,
    repo: task.repo,
    prNumber: task.pr_number,
    filesChanged: fixReport?.files_changed,
    commentsAddressed: fixReport?.comments_addressed,
  });
}

/**
 * Post a fallback consolidated review to GitHub when all summary retries are exhausted.
 * Uses the timeout-style format: individual reviews concatenated.
 */
async function postFallbackConsolidatedReview(
  store: DataStore,
  github: GitHubService,
  task: ReviewTask,
  workerClaims: import('@opencara/shared').TaskClaim[],
  logger: Logger,
): Promise<void> {
  try {
    const token = await github.getInstallationToken(task.github_installation_id);
    const timeoutMinutes = Math.round((task.timeout_at - task.created_at) / 60000);

    const reviews: TimeoutReview[] = workerClaims.filter(isCompletedReview).map((c) => ({
      model: c.model ?? 'unknown',
      tool: c.tool ?? 'unknown',
      verdict: (c.verdict as ReviewVerdict) ?? 'comment',
      review_text: c.review_text!,
    }));

    const body = formatTimeoutComment(timeoutMinutes, reviews);
    await github.postPrComment(task.owner, task.repo, task.pr_number, body, token);

    logger.info('Fallback consolidated review posted', {
      taskId: task.id,
      reviewCount: reviews.length,
    });
  } catch (err) {
    logger.error('Failed to post fallback consolidated review', {
      taskId: task.id,
      error: err instanceof Error ? err.message : String(err),
    });
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

/** A task that passed non-claim eligibility filters during poll, pending batch claim check. */
interface PollCandidate {
  task: ReviewTask;
  role: TaskRole;
  claimId: string;
}

// ── Poll pre-computation (shared between single and batch poll) ──

/** Data pre-computed once per poll request and shared across agent filtering passes. */
interface PollContext {
  tasks: ReviewTask[];
  tasksById: Map<string, ReviewTask>;
  dedupBlockedRepos: Set<string>;
  oldestDedupPerRepo: Map<string, ReviewTask>;
  groupClaimedModels: Map<string, Set<string>>;
}

/**
 * Pre-compute shared poll context: pending tasks, dedup serialization state,
 * and model diversity maps. This is expensive and should be computed once per
 * request, then shared across all agents in a batch poll.
 */
async function buildPollContext(store: DataStore): Promise<PollContext> {
  const tasks = await store.listTasks({ status: ['pending'] });
  const tasksById = new Map(tasks.map((t) => [t.id, t]));

  // Dedup serialization: build blocked-repo set and oldest-per-repo map
  const reviewingTasks = await store.listTasks({ status: ['reviewing'] });
  const dedupBlockedRepos = new Set<string>();
  for (const t of reviewingTasks) {
    if (isDedupRole(t.task_type)) {
      dedupBlockedRepos.add(`${t.owner}/${t.repo}`);
    }
  }
  const oldestDedupPerRepo = new Map<string, ReviewTask>();
  for (const t of tasks) {
    if (!isDedupRole(t.task_type)) continue;
    const repoKey = `${t.owner}/${t.repo}`;
    const existing = oldestDedupPerRepo.get(repoKey);
    if (!existing || t.created_at < existing.created_at) {
      oldestDedupPerRepo.set(repoKey, t);
    }
  }

  // Model diversity: build claimed-models-per-group map
  const pendingGroupIds = new Set<string>();
  for (const t of tasks) {
    if (t.group_id && t.config.modelDiversityGraceMs > 0) {
      pendingGroupIds.add(t.group_id);
    }
  }
  const groupClaimedModels = new Map<string, Set<string>>();
  if (pendingGroupIds.size > 0) {
    for (const groupId of pendingGroupIds) {
      const groupTasks = await store.getTasksByGroup(groupId);
      for (const gt of groupTasks) {
        if (gt.status !== 'reviewing' && gt.status !== 'completed') continue;
        const claims = await store.getClaims(gt.id);
        for (const claim of claims) {
          if (claim.model) {
            let models = groupClaimedModels.get(groupId);
            if (!models) {
              models = new Set();
              groupClaimedModels.set(groupId, models);
            }
            models.add(claim.model);
          }
        }
      }
    }
  }

  return { tasks, tasksById, dedupBlockedRepos, oldestDedupPerRepo, groupClaimedModels };
}

/** Parameters for filtering tasks for a single agent. */
interface AgentFilter {
  agentId: string;
  acceptedRoles: Set<string> | null;
  agentRepos: Set<string> | null;
  model?: string;
  tool?: string;
  /** All repo filters for summary task visibility (any match = allowed). */
  repoFilters?: RepoConfig[];
  githubUsername?: string;
}

/**
 * Filter tasks for a single agent: applies role, repo, eligibility, visibility,
 * and dedup serialization filters. Returns the list of PollTask objects available
 * to this agent.
 *
 * Shared between POST /api/tasks/poll and POST /api/tasks/poll/batch.
 */
async function filterTasksForAgent(
  ctx: PollContext,
  agent: AgentFilter,
  store: DataStore,
  github: GitHubService,
  logger: Logger,
): Promise<PollTask[]> {
  const { tasks, tasksById, dedupBlockedRepos, oldestDedupPerRepo, groupClaimedModels } = ctx;

  // First pass: filter tasks by non-claim criteria, collecting candidate claim IDs
  const candidates: PollCandidate[] = [];

  for (const task of tasks) {
    // Private repo tasks: only return to agents declaring matching repos
    if (
      task.private &&
      (!agent.agentRepos || !agent.agentRepos.has(`${task.owner}/${task.repo}`))
    ) {
      continue;
    }

    const remainingMs = task.timeout_at - Date.now();
    if (remainingMs <= 0) continue;

    // Filter by task_type matching agent's declared roles
    const taskRole = task.task_type;
    if (agent.acceptedRoles && !agent.acceptedRoles.has(taskRole)) continue;

    // Eligibility check based on role
    const eligibilityRole = isSummaryTask(task) ? 'summary' : taskRole;
    const { eligible } = isAgentEligibleForRole(
      task.config,
      eligibilityRole,
      agent.agentId,
      agent.githubUsername,
    );
    if (!eligible) continue;

    // Grace period visibility checks
    if (isSummaryTask(task)) {
      if (!isSummaryVisibleToAgent(task, agent.agentId, agent.model)) continue;
      // Repo filter for summary agents — any matching filter allows the task.
      // For modes that need owner/org context (private), fall back to agentRepos
      // which was pre-built from the agent's declared repo list.
      if (agent.repoFilters && agent.repoFilters.length > 0) {
        const repoKey = `${task.owner}/${task.repo}`;
        const allowed = agent.repoFilters.some((rf) => {
          if (rf.mode === 'private') {
            // Private mode needs agentOwner/userOrgs which the server doesn't have.
            // Fall back to checking the explicit list, which is equivalent to
            // whitelist behavior for the repos the agent declared.
            return (rf.list ?? []).includes(repoKey);
          }
          return isRepoAllowed(rf, task.owner, task.repo);
        });
        if (!allowed) continue;
      }
    } else {
      // Worker task — check model/tool preference grace period
      if (!isWorkerVisibleToAgent(task, agent.model, agent.tool)) continue;
    }

    // Target model preference: during grace period, only matching agents see the task
    if (!isTargetModelVisible(task, agent.model)) continue;

    // Model diversity: prefer agents with different models across the group
    if (!isModelDiversityVisible(task, agent.model, groupClaimedModels)) continue;

    candidates.push({
      task,
      role: taskRole,
      claimId: `${task.id}:${agent.agentId}:${taskRole}`,
    });
  }

  // Batch-fetch all candidate claims in a single query (eliminates N+1)
  const claimIds = candidates.map((c) => c.claimId);
  const existingClaims = await store.getClaimsBatch(claimIds);

  // Second pass: filter by existing claim status and build result
  const available: PollTask[] = [];
  for (const { task, role, claimId } of candidates) {
    const existing = existingClaims.get(claimId);
    if (existing && !isClaimFailed(existing)) {
      continue;
    }

    // Dedup serialization: skip if repo has a claimed dedup task or this isn't the oldest
    if (isDedupRole(task.task_type)) {
      const repoKey = `${task.owner}/${task.repo}`;
      if (dedupBlockedRepos.has(repoKey)) continue;
      const oldest = oldestDedupPerRepo.get(repoKey);
      if (oldest && oldest.id !== task.id) continue;
    }

    const remainingMs = task.timeout_at - Date.now();
    const pollTask: PollTask = {
      task_id: task.id,
      owner: task.owner,
      repo: task.repo,
      pr_number: task.pr_number,
      diff_url: task.diff_url,
      diff_size: task.diff_size,
      timeout_seconds: Math.max(0, Math.floor(remainingMs / 1000)),
      prompt: task.prompt,
      role,
      task_type: task.task_type,
      issue_number: task.issue_number,
      issue_title: task.issue_title,
      issue_body: task.issue_body,
      target_model: task.target_model,
      pr_review_comments: task.pr_review_comments,
      head_sha: task.head_sha,
      head_ref: task.head_ref || undefined,
    };

    // For summary tasks, include worker results from the group
    if (isSummaryTask(task)) {
      pollTask.reviews = await getWorkerReviews(store, task.group_id);
    }

    // For dedup tasks with an index issue, fetch the structured index body
    if (
      (task.task_type === 'pr_dedup' ||
        task.task_type === 'issue_dedup' ||
        task.feature === 'dedup_pr' ||
        task.feature === 'dedup_issue') &&
      task.index_issue_number
    ) {
      try {
        const token = await github.getInstallationToken(task.github_installation_id);
        pollTask.index_issue_body = await fetchIndexBody(
          github,
          task.owner,
          task.repo,
          task.index_issue_number,
          token,
        );
      } catch (err) {
        logger.warn('Failed to fetch dedup index body', {
          taskId: task.id,
          indexIssue: task.index_issue_number,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    available.push(pollTask);
  }

  // Sort preferred tasks first (only applies to worker tasks)
  available.sort((a, b) => {
    if (isSortableWorkerRole(a.role) && isSortableWorkerRole(b.role)) {
      const aTask = tasksById.get(a.task_id);
      const bTask = tasksById.get(b.task_id);
      const aPref = aTask ? isReviewPreferredAgent(aTask.config, agent.model, agent.tool) : false;
      const bPref = bTask ? isReviewPreferredAgent(bTask.config, agent.model, agent.tool) : false;
      if (aPref && !bPref) return -1;
      if (!aPref && bPref) return 1;
    }
    return 0;
  });

  return available;
}

/**
 * Get completed worker reviews for a group (used for summary poll/claim responses).
 */
async function getWorkerReviews(store: DataStore, groupId: string): Promise<ClaimReview[]> {
  const groupTasks = await store.getTasksByGroup(groupId);
  const reviews: ClaimReview[] = [];
  for (const gt of groupTasks) {
    if (!isWorkerTask(gt)) continue;
    const claims = await store.getClaims(gt.id);
    for (const cl of claims) {
      if (cl.status === 'completed' && cl.review_text) {
        reviews.push({
          agent_id: cl.agent_id,
          review_text: cl.review_text,
          verdict: (cl.verdict ?? 'comment') as ReviewVerdict,
          model: cl.model,
          tool: cl.tool,
          thinking: cl.thinking,
        });
      }
    }
  }
  return reviews;
}

export function taskRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  // OAuth required on all task endpoints
  app.use('/api/tasks/*', requireOAuth());

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

    const pollCtx = await buildPollContext(store);
    const available = await filterTasksForAgent(
      pollCtx,
      {
        agentId: agent_id,
        acceptedRoles,
        agentRepos,
        model: body.model,
        tool: body.tool,
        repoFilters: synthesize_repos ? [synthesize_repos] : undefined,
        githubUsername: verifiedIdentity?.github_username,
      },
      store,
      github,
      logger,
    );

    return c.json<PollResponse>({ tasks: available });
  });

  // ── Batch Poll ──────────────────────────────────────────────

  app.post(
    '/api/tasks/poll/batch',
    rateLimitByIP({ ...POLL_RATE_LIMIT, prefix: 'batch-poll' }),
    async (c) => {
      const store = c.get('store');
      const github = c.get('github');
      const logger = c.get('logger');
      const verifiedIdentity = c.get('verifiedIdentity');
      const body = await parseBody(c, BatchPollRequestSchema);
      if (body instanceof Response) return body;

      // Check timeouts lazily (throttled to every 30s per isolate)
      await maybeCheckTimeouts(store, github, logger);

      // Build shared poll context once for all agents
      const pollCtx = await buildPollContext(store);

      // Collect per-agent task lists
      const agentTasks = new Map<string, PollTask[]>();
      for (const agent of body.agents) {
        // repo_filters controls both private repo access and summary task visibility
        const repoFilterSet =
          agent.repo_filters && agent.repo_filters.length > 0 ? agent.repo_filters : null;
        // Build a set of declared repos from whitelist repo_filters
        const declaredRepos = new Set<string>();
        if (repoFilterSet) {
          for (const rf of repoFilterSet) {
            if (rf.list) {
              for (const entry of rf.list) declaredRepos.add(entry);
            }
          }
        }

        const available = await filterTasksForAgent(
          pollCtx,
          {
            agentId: agent.agent_name,
            acceptedRoles: new Set(agent.roles),
            agentRepos: declaredRepos.size > 0 ? declaredRepos : null,
            model: agent.model,
            tool: agent.tool,
            repoFilters: repoFilterSet ?? undefined,
            githubUsername: verifiedIdentity?.github_username,
          },
          store,
          github,
          logger,
        );
        agentTasks.set(agent.agent_name, available);
      }

      // Deduplicate across agents — each task goes to exactly one agent.
      // Priority: preferred model/tool match wins, then first-come (request order).
      const assignedTaskIds = new Set<string>();
      const assignments: Record<string, PollTask[]> = {};

      // Initialize all agents with empty arrays
      for (const agent of body.agents) {
        assignments[agent.agent_name] = [];
      }

      // First pass: assign tasks where agent matches an explicit preferred model/tool
      for (const agent of body.agents) {
        const tasks = agentTasks.get(agent.agent_name) ?? [];
        for (const task of tasks) {
          if (assignedTaskIds.has(task.task_id)) continue;
          const reviewTask = pollCtx.tasksById.get(task.task_id);
          if (!reviewTask) continue;
          // Only prioritize when the task has explicit preferences AND the agent matches
          const { preferredModels, preferredTools } = reviewTask.config;
          if (preferredModels.length === 0 && preferredTools.length === 0) continue;
          if (isReviewPreferredAgent(reviewTask.config, agent.model, agent.tool)) {
            assignments[agent.agent_name].push(task);
            assignedTaskIds.add(task.task_id);
          }
        }
      }

      // Second pass: distribute remaining tasks round-robin across agents
      let changed = true;
      while (changed) {
        changed = false;
        for (const agent of body.agents) {
          const tasks = agentTasks.get(agent.agent_name) ?? [];
          const next = tasks.find((t) => !assignedTaskIds.has(t.task_id));
          if (next) {
            assignments[agent.agent_name].push(next);
            assignedTaskIds.add(next.task_id);
            changed = true;
          }
        }
      }

      return c.json<BatchPollResponse>({
        assignments: Object.fromEntries(
          Object.entries(assignments).map(([name, tasks]) => [name, { tasks }]),
        ),
      });
    },
  );

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

    if (!isTaskActive(task)) {
      return apiError(c, 409, 'CLAIM_CONFLICT', `Task is ${task.status}`);
    }

    if (task.timeout_at <= Date.now()) {
      return apiError(c, 409, 'CLAIM_CONFLICT', 'Task has timed out');
    }

    // Validate role matches task_type
    if (role !== task.task_type) {
      return apiError(
        c,
        409,
        'CLAIM_CONFLICT',
        `Role '${role}' does not match task type '${task.task_type}'`,
      );
    }

    // Check whitelist/blacklist eligibility
    const eligibilityRole = isSummaryTask(task) ? 'summary' : role;
    const eligibility = isAgentEligibleForRole(
      task.config,
      eligibilityRole,
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

    // Grace period check for summary tasks
    if (isSummaryTask(task) && !isSummaryVisibleToAgent(task, agent_id, model)) {
      return apiError(c, 409, 'CLAIM_CONFLICT', 'No slots available');
    }

    // Atomic CAS: pending → reviewing
    const claimed = await store.claimTask(taskId);
    if (!claimed) {
      return apiError(c, 409, 'CLAIM_CONFLICT', 'Task already claimed');
    }

    // Role-aware claim ID
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
      // Release the task so another agent can claim it
      await store.releaseTask(taskId);
      return apiError(c, 409, 'CLAIM_CONFLICT', 'Agent already has a claim on this task');
    }

    // Update heartbeat — keep agent alive after successful claim
    await store.setAgentLastSeen(agent_id, Date.now());

    // For summary claims, return completed worker results from the group
    if (isSummaryTask(task)) {
      const reviews = await getWorkerReviews(store, task.group_id);
      return c.json<ClaimResponse>({ claimed: true, reviews });
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

    const {
      agent_id,
      type,
      review_text,
      verdict,
      tokens_used,
      dedup_report,
      triage_report,
      implement_report,
      fix_report,
    } = result.data;

    // Role-aware claim lookup
    const claimId = `${taskId}:${agent_id}:${type}`;
    const claim = await store.getClaim(claimId);

    if (!claim) {
      logger.error('Result rejected — no claim found', { agentId: agent_id, taskId });
      return apiError(c, 404, 'CLAIM_NOT_FOUND', 'No claim found for this agent on this task');
    }

    if (!isClaimPending(claim)) {
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

    // Update heartbeat — keep agent alive after successful result submission
    await store.setAgentLastSeen(agent_id, Date.now());

    // Update the claim with result
    await store.updateClaim(claimId, {
      status: 'completed',
      review_text,
      verdict: verdict as ReviewVerdict | undefined,
      tokens_used,
    });

    // Check if the task exists
    const task = await store.getTask(taskId);
    if (!task) {
      return c.json<ResultResponse>({ success: true });
    }

    if (isSummaryTask(task)) {
      // ── Summary result — dispatch by feature ──────────────

      // Quality gate for review summaries
      if (task.feature === 'review') {
        const workerReviews = await getWorkerReviews(store, task.group_id);
        const individualTexts = workerReviews.map((r) => r.review_text);

        const evaluation = evaluateSummaryQuality(review_text, individualTexts);

        if (!evaluation.pass) {
          // Reject: revert claim, release task, record rejection
          await store.updateClaim(claimId, { status: 'rejected' });
          await store.releaseTask(taskId);
          await store.recordAgentRejection(
            agent_id,
            `summary_quality: ${evaluation.reason}`,
            Date.now(),
          );

          const retryCount = await store.incrementSummaryRetryCount(taskId);

          logger.warn('Summary quality rejected', {
            taskId,
            agentId: agent_id,
            reason: evaluation.reason,
            retryCount,
          });

          // If retries exhausted, fall back to consolidated post
          if (retryCount !== null && retryCount >= MAX_SUMMARY_RETRIES) {
            logger.info('Summary retries exhausted — posting fallback consolidated reviews', {
              taskId,
              retryCount,
            });
            const workerClaims: import('@opencara/shared').TaskClaim[] = [];
            const groupTasks = await store.getTasksByGroup(task.group_id);
            for (const gt of groupTasks) {
              if (isWorkerTask(gt)) {
                const gtClaims = await store.getClaims(gt.id);
                workerClaims.push(...gtClaims);
              }
            }
            await postFallbackConsolidatedReview(store, github, task, workerClaims, logger);
            await store.deleteTasksByGroup(task.group_id);
            return c.json<ResultResponse>({ success: true });
          }

          return apiError(
            c,
            400,
            'REVIEW_QUALITY_REJECTED',
            `Summary rejected: ${evaluation.reason}`,
          );
        }
      }

      // Dispatch by feature
      try {
        switch (task.feature) {
          case 'review':
            await handleReviewSummaryResult(
              store,
              github,
              task,
              task.group_id,
              { review_text },
              logger,
            );
            break;
          case 'dedup_pr':
          case 'dedup_issue':
            await handleDedupSummaryResult(
              store,
              github,
              task,
              task.group_id,
              dedup_report as DedupReport | undefined,
              review_text,
              logger,
            );
            break;
          case 'triage':
            await handleTriageSummaryResult(
              store,
              github,
              task,
              task.group_id,
              triage_report as TriageReport | undefined,
              review_text,
              logger,
            );
            break;
          case 'implement':
            await handleImplementSummaryResult(
              store,
              github,
              task,
              task.group_id,
              implement_report as ImplementReport | undefined,
              review_text,
              logger,
            );
            break;
          case 'fix':
            await handleFixSummaryResult(
              store,
              github,
              task,
              task.group_id,
              fix_report as FixReport | undefined,
              review_text,
              logger,
            );
            break;
          default:
            logger.error('Unknown feature for summary result', {
              taskId,
              feature: task.feature,
            });
        }

        // Delete all tasks in the group after posting
        await store.deleteTasksByGroup(task.group_id);
      } catch (err) {
        logger.error('Failed to post summary result to GitHub', {
          taskId,
          feature: task.feature,
          error: err instanceof Error ? err.message : String(err),
        });
        // On failure, release the task so another agent can retry
        await store.releaseTask(taskId);
        await store.updateClaim(claimId, { status: 'error' });
      }
    } else {
      // ── Worker result — atomically complete and maybe create summary ──

      const summaryTaskId = crypto.randomUUID();
      const now = Date.now();
      const summaryTask: ReviewTask = {
        ...task,
        id: summaryTaskId,
        task_type: 'summary',
        status: 'pending',
        queue: 'summary',
        prompt: task.prompt,
        created_at: now,
        timeout_at: now + (task.timeout_at - task.created_at),
        reviews_completed_at: now,
      };

      // Atomically: mark worker completed + create summary if all workers done.
      // Uses a single D1 batch transaction to prevent the race condition where
      // concurrent result submissions could both miss or both create the summary.
      const summaryCreated = await store.completeWorkerAndMaybeCreateSummary(taskId, summaryTask);

      if (summaryCreated) {
        logger.info('All workers complete — summary task created', {
          groupId: task.group_id,
          feature: task.feature,
          summaryTaskId,
        });
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

    // Try role-aware claim IDs
    const claim = await findClaimForAgent(store, taskId, agent_id);

    if (!claim) {
      return apiError(c, 404, 'CLAIM_NOT_FOUND', 'Claim not found');
    }

    if (!isClaimPending(claim)) {
      // Idempotent: already rejected → return 200
      if (claim.status === 'rejected') {
        return c.json({ success: true });
      }
      return apiError(c, 409, 'CLAIM_CONFLICT', `Claim is ${claim.status}, expected pending`);
    }

    await store.updateClaim(claim.id, { status: 'rejected' });

    // Release the task so another agent can claim it
    await store.releaseTask(taskId);

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

    // Try role-aware claim IDs
    const claim = await findClaimForAgent(store, taskId, agent_id);

    if (!claim) {
      return apiError(c, 404, 'CLAIM_NOT_FOUND', 'Claim not found');
    }

    if (!isClaimPending(claim)) {
      // Idempotent: already errored → return 200
      if (claim.status === 'error') {
        return c.json({ success: true });
      }
      return apiError(c, 409, 'CLAIM_CONFLICT', `Claim is ${claim.status}, expected pending`);
    }

    await store.updateClaim(claim.id, { status: 'error' });

    // Release the task so another agent can claim it
    await store.releaseTask(taskId);

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

/** Check if a role is a sortable worker role for preferred agent ordering. */
function isSortableWorkerRole(role: TaskRole): boolean {
  return role !== 'summary';
}

/**
 * Find a pending claim for an agent on a task. Checks all possible role-aware
 * claim IDs (summary first since that's the more impactful role to release).
 */
async function findClaimForAgent(
  store: DataStore,
  taskId: string,
  agentId: string,
): Promise<import('@opencara/shared').TaskClaim | null> {
  const roles: TaskRole[] = ['summary', 'review', 'pr_dedup', 'issue_dedup', 'issue_triage'];

  for (const role of roles) {
    const claim = await store.getClaim(`${taskId}:${agentId}:${role}`);
    if (claim && isClaimPending(claim)) return claim;
  }

  // Return any found claim for idempotency checks (rejected/error/completed)
  for (const role of roles) {
    const claim = await store.getClaim(`${taskId}:${agentId}:${role}`);
    if (claim) return claim;
  }

  return null;
}
