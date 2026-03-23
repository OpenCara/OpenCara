import type { MiddlewareHandler } from 'hono';
import type { ErrorResponse } from '@opencara/shared';
import type { Env, AppVariables } from '../types.js';

/** Cache parsed key sets to avoid re-parsing on every request within an isolate. */
const keySetCache = new Map<string, Set<string> | null>();

/**
 * Parse the API_KEYS env var into a Set for lookup.
 * Returns null when no keys are configured (open mode).
 * Results are cached per raw string value.
 */
function parseApiKeys(raw: string | undefined): Set<string> | null {
  const cacheKey = raw ?? '';
  const cached = keySetCache.get(cacheKey);
  if (cached !== undefined) return cached;

  if (!raw || raw.trim() === '') {
    keySetCache.set(cacheKey, null);
    return null;
  }
  const keys = raw
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length > 0);
  const result = keys.length > 0 ? new Set(keys) : null;
  keySetCache.set(cacheKey, result);
  return result;
}

/**
 * Constant-time string comparison to prevent timing side-channel attacks.
 * Always compares all characters regardless of mismatch position.
 */
function timingSafeEquals(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
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

    const token = match[1].trim();

    // Timing-safe comparison against all valid keys
    let valid = false;
    for (const key of validKeys) {
      if (timingSafeEquals(key, token)) valid = true;
    }

    if (!valid) {
      return c.json<ErrorResponse>(
        { error: { code: 'UNAUTHORIZED', message: 'Invalid API key' } },
        401,
      );
    }

    await next();
  };
}

/** Reset the key set cache. Test-only. */
export function resetKeySetCache(): void {
  keySetCache.clear();
}
