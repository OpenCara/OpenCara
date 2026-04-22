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
 * Thrown when a task invariant is violated at insert time. The guard exists to
 * catch regressions where a PR-scoped task (pr_number > 0) is created without a
 * base_ref, which silently forces agents onto the slow `gh pr diff` fallback
 * because the CLI coerces empty base_ref to undefined. See #776.
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
      `Refusing to insert PR-scoped task without base_ref: ${task.owner}/${task.repo}#${task.pr_number} (feature=${task.feature}, task_id=${task.id})`,
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
 * Validate that a ReviewTask satisfies the base_ref invariant before insert:
 * PR-scoped tasks (pr_number > 0) must carry a non-empty base_ref so the CLI
 * can take the local `git diff` fast path. Issue-scoped tasks (pr_number = 0)
 * have no diff and are exempt.
 */
export function assertTaskInvariants(task: {
  id: string;
  owner: string;
  repo: string;
  pr_number: number;
  base_ref: string;
  feature: string;
}): void {
  if (task.pr_number > 0 && !task.base_ref) {
    throw new MissingBaseRefError(task);
  }
}
