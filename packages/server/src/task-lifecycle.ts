/**
 * Task Lifecycle State Machine
 *
 * Encapsulates the implicit state machine that was previously spread across
 * route handlers as ad-hoc queue/status string comparisons.
 *
 * ## State Diagram
 *
 *   TaskStatus: pending → reviewing → [deleted on completion or timeout]
 *   TaskQueue:  review  → summary   → finished → [deleted]
 *
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │                     Task Created                           │
 *   │  status=pending, queue=review (or summary if count==1)     │
 *   └────────────────────────┬────────────────────────────────────┘
 *                            │ first claim
 *                            ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  status=reviewing, queue=review                            │
 *   │  Agents claim review slots (atomic increment)              │
 *   └────────────────────────┬────────────────────────────────────┘
 *                            │ all review slots completed
 *                            ▼
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  status=reviewing, queue=summary                           │
 *   │  Summary agent claims (atomic CAS → queue=finished)        │
 *   └──────────┬────────────────────────────┬─────────────────────┘
 *              │ summary claimed             │ quality rejected
 *              ▼                             │ (→ queue=summary, retry)
 *   ┌──────────────────────┐                │
 *   │  queue=finished      │◄───────────────┘
 *   │  summary_agent_id set│
 *   └──────────┬───────────┘
 *              │ result submitted + posted to GitHub
 *              ▼
 *   ┌──────────────────────┐
 *   │  [task deleted]      │
 *   └──────────────────────┘
 *
 * ## Claim Status Lifecycle
 *
 *   pending → completed  (result submitted)
 *   pending → rejected   (agent rejected or quality gate)
 *   pending → error      (agent reported error or abandoned)
 */

import type { ReviewTask, TaskClaim, TaskQueue } from '@opencara/shared';

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

/** True if the task is in the review phase (accepting review claims). */
export function isInReviewQueue(task: ReviewTask): boolean {
  return task.queue === 'review';
}

/** True if the task is in the summary phase (accepting summary claims). */
export function isInSummaryQueue(task: ReviewTask): boolean {
  return task.queue === 'summary';
}

/** True if the summary slot has been claimed (queue=finished). */
export function isSummaryClaimed(task: ReviewTask): boolean {
  return task.queue === 'finished';
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
 * Check if all review slots are filled, meaning the task should transition
 * from review → summary queue.
 */
export function shouldTransitionToSummary(
  completedReviews: number,
  reviewSlots: number,
  currentQueue: TaskQueue | string,
): boolean {
  return reviewSlots > 0 && completedReviews >= reviewSlots && currentQueue === 'review';
}
