import type { MiddlewareHandler } from 'hono';
import type { ErrorResponse } from '@opencara/shared';
import type { Env, AppVariables } from '../types.js';

/**
 * Parse the API_KEYS env var into a Set for O(1) lookup.
 * Returns null when no keys are configured (open mode).
 */
function parseApiKeys(raw: string | undefined): Set<string> | null {
  if (!raw || raw.trim() === '') return null;
  const keys = raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  return keys.length > 0 ? new Set(keys) : null;
}

/**
 * Middleware that requires a valid API key via `Authorization: Bearer <key>`.
 *
 * - When `API_KEYS` env var is not set or empty, all requests pass (open mode).
 * - When set, requests must include a valid Bearer token.
 * - Returns 401 UNAUTHORIZED for missing or invalid tokens.
 */
export function requireApiKey(): MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> {
  return async (c, next) => {
    const validKeys = parseApiKeys(c.env.API_KEYS);

    // Open mode — no keys configured, skip auth
    if (!validKeys) {
      await next();
      return;
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      return c.json<ErrorResponse>(
        { error: { code: 'UNAUTHORIZED', message: 'Missing Authorization header' } },
        401,
      );
    }

    // Expect "Bearer <token>" format
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return c.json<ErrorResponse>(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid Authorization header format' } },
        401,
      );
    }

    const token = match[1];
    if (!validKeys.has(token)) {
      return c.json<ErrorResponse>(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } },
        401,
      );
    }

    await next();
  };
}
