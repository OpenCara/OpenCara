import type { Context } from 'hono';
import type { ErrorCode, ErrorResponse } from '@opencara/shared';

type StatusCode = 400 | 401 | 403 | 404 | 409 | 429 | 500;

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
