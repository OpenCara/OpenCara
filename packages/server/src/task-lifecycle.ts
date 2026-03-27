/**
 * Task Lifecycle State Machine
 *
 * Separate task model: each task is one unit of work (worker or summary).
 * Tasks are linked by group_id. Workers complete independently; when all
 * workers in a group finish, a summary task is created.
 *
 * ## State Diagram (per task)
 *
 *   TaskStatus: pending → reviewing → completed → [deleted]
 *
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  Worker Task Created (task_type = review/dedup/triage)    │
 *   │  status = pending                                         │
 *   └──────────────────────────┬─────────────────────────────────┘
 *                              │ agent claims (CAS: pending → reviewing)
 *                              ▼
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  status = reviewing                                       │
 *   │  Agent works on the task                                  │
 *   └──────────────────────────┬─────────────────────────────────┘
 *                              │ result submitted → status = completed
 *                              ▼
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  status = completed                                       │
 *   │  Check: all workers in group completed?                   │
 *   │  Yes → create summary task for the group                  │
 *   └──────────────────────────┬─────────────────────────────────┘
 *                              │
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  Summary Task Created (task_type = summary)               │
 *   │  status = pending                                         │
 *   └──────────────────────────┬─────────────────────────────────┘
 *                              │ agent claims → reviews → submits result
 *                              ▼
 *   ┌────────────────────────────────────────────────────────────┐
 *   │  Summary result posted to GitHub                          │
 *   │  All tasks in group deleted                               │
 *   └────────────────────────────────────────────────────────────┘
 *
 * ## Claim Status Lifecycle
 *
 *   pending → completed  (result submitted)
 *   pending → rejected   (agent rejected or quality gate)
 *   pending → error      (agent reported error or abandoned)
 */

import type { ReviewTask, TaskClaim } from '@opencara/shared';
import { isDedupRole, isTriageRole } from '@opencara/shared';

// ── Task State Queries ──────────────────────────────────────────

/** True if the task is actively accepting claims (not completed/timed out). */
export function isTaskActive(task: ReviewTask): boolean {
  return task.status === 'pending' || task.status === 'reviewing';
}

/**
 * True if the task is done (already posted or about to be deleted).
 * Checks both status='completed' and queue='completed' as defense-in-depth —
 * queue='completed' exists in the TaskQueue union but is not used in normal flows.
 */
export function isTaskTerminal(task: ReviewTask): boolean {
  return task.status === 'completed' || task.queue === 'completed';
}

/** True if the task is a worker task (review only — needs summary after all workers complete). */
export function isWorkerTask(task: ReviewTask): boolean {
  return task.task_type === 'review';
}

/**
 * True if the task is a "final" task that dispatches results directly.
 * This includes summary tasks and all dedup/triage variants.
 */
export function isSummaryTask(task: ReviewTask): boolean {
  return (
    task.task_type === 'summary' || isDedupRole(task.task_type) || isTriageRole(task.task_type)
  );
}

/** True if the task has timed out. Accepts optional `now` for testability. */
export function isTimedOut(task: ReviewTask, now: number = Date.now()): boolean {
  return task.timeout_at <= now;
}

// ── Claim State Queries ─────────────────────────────────────────

/** True if the claim is still in progress (awaiting result). */
export function isClaimPending(claim: TaskClaim): boolean {
  return claim.status === 'pending';
}

/** True if the claim has a terminal status (cannot transition further). */
export function isClaimTerminal(claim: TaskClaim): boolean {
  return claim.status === 'completed' || claim.status === 'rejected' || claim.status === 'error';
}

/** True if the claim was unsuccessful (rejected or errored). */
export function isClaimFailed(claim: TaskClaim): boolean {
  return claim.status === 'rejected' || claim.status === 'error';
}

/** True if the claim completed with a review text. */
export function isCompletedReview(claim: TaskClaim): boolean {
  return claim.role === 'review' && claim.status === 'completed' && !!claim.review_text;
}

// ── Transition Predicates ───────────────────────────────────────

/**
 * Check if all worker tasks in a group are completed, meaning a summary
 * task should be created for synthesis.
 */
export function shouldCreateSummaryTask(completedCount: number, workerTaskCount: number): boolean {
  return workerTaskCount > 0 && completedCount >= workerTaskCount;
}

// ── Deprecated predicates (kept for backward compat during migration) ──

/**
 * @deprecated Use isWorkerTask/isSummaryTask instead.
 * True if the task is in the review phase (accepting review claims).
 */
export function isInReviewQueue(task: ReviewTask): boolean {
  return task.queue === 'review';
}

/**
 * @deprecated Use isSummaryTask instead.
 * True if the task is in the summary phase (accepting summary claims).
 */
export function isInSummaryQueue(task: ReviewTask): boolean {
  return task.queue === 'summary';
}

/**
 * @deprecated No longer used in separate task model.
 * True if the summary slot has been claimed (queue=finished).
 */
export function isSummaryClaimed(task: ReviewTask): boolean {
  return task.queue === 'finished';
}

/**
 * @deprecated Use shouldCreateSummaryTask instead.
 * Check if all review slots are filled.
 */
export function shouldTransitionToSummary(
  completedReviews: number,
  reviewSlots: number,
  currentQueue: string,
): boolean {
  return reviewSlots > 0 && completedReviews >= reviewSlots && currentQueue === 'review';
}
