import type { Context } from 'hono';
import type { ErrorCode, ErrorResponse } from '@opencara/shared';

type StatusCode = 400 | 401 | 403 | 404 | 409 | 426 | 429 | 500;

/**
 * Return a standardized JSON error response.
 *
 * Usage:
 *   return apiError(c, 400, 'INVALID_REQUEST', 'agent_id is required');
 */
export function apiError(
  c: Context,
  status: StatusCode,
  code: ErrorCode,
  message: string,
): Response {
  return c.json<ErrorResponse>({ error: { code, message } }, status);
}

/**
 * Thrown by MemoryDataStore when a PR-scoped task (pr_number > 0) is inserted
 * without a base_ref. Memory throws so CI regressions fail loud; D1DataStore
 * instead logs-and-proceeds (see #776) because #775 lets the CLI derive
 * base_ref locally — a prod regression should be reported via telemetry, not
 * turned into a user-visible skipped review.
 */
export class MissingBaseRefError extends Error {
  readonly task_id: string;
  readonly owner: string;
  readonly repo: string;
  readonly pr_number: number;
  readonly feature: string;

  constructor(task: {
    id: string;
    owner: string;
    repo: string;
    pr_number: number;
    feature: string;
  }) {
    super(
      `PR-scoped task missing base_ref: ${task.owner}/${task.repo}#${task.pr_number} (feature=${task.feature}, task_id=${task.id})`,
    );
    this.name = 'MissingBaseRefError';
    this.task_id = task.id;
    this.owner = task.owner;
    this.repo = task.repo;
    this.pr_number = task.pr_number;
    this.feature = task.feature;
  }
}

/**
 * True if a ReviewTask violates the base_ref invariant: PR-scoped tasks
 * (pr_number > 0) must carry a non-empty base_ref so the CLI can take the
 * local `git diff` fast path. Issue-scoped tasks (pr_number = 0) have no
 * diff and are exempt.
 */
export function violatesBaseRefInvariant(task: { pr_number: number; base_ref: string }): boolean {
  return task.pr_number > 0 && !task.base_ref;
}
