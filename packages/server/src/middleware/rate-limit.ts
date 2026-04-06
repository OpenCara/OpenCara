import type { Context, MiddlewareHandler } from 'hono';
import type { ErrorResponse } from '@opencara/shared';
import type { Env, AppVariables } from '../types.js';

/**
 * In-memory sliding window rate limiter.
 *
 * Tracks request timestamps per key (agent_id or IP) within a configurable
 * window. Returns 429 with Retry-After header when the limit is exceeded.
 *
 * Per-isolate limiting is sufficient — it still prevents hot loops from
 * individual agents without KV overhead. Isolate recycling naturally
 * resets counters, which is acceptable.
 */

interface RateLimiterConfig {
  /** Maximum requests allowed within the window. */
  maxRequests: number;
  /** Window duration in milliseconds. */
  windowMs: number;
}

/** Sliding window entries: Map<key, timestamp[]> */
const windows = new Map<string, number[]>();

/** Maximum tracked keys to prevent memory exhaustion from key flooding. */
const MAX_TRACKED_KEYS = 10_000;

/** Interval for periodic cleanup of expired entries (5 minutes). */
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/** All rate limit configs use 60s windows; cleanup uses this fixed value. */
const CLEANUP_WINDOW_MS = 60_000;

let lastCleanup = 0;

/**
 * Remove expired entries from all windows to prevent memory leaks.
 */
function cleanupExpired(): void {
  const now = Date.now();
  if (now - lastCleanup < CLEANUP_INTERVAL_MS) return;
  lastCleanup = now;

  const cutoff = now - CLEANUP_WINDOW_MS;
  for (const [key, timestamps] of windows) {
    const valid = timestamps.filter((t) => t > cutoff);
    if (valid.length === 0) {
      windows.delete(key);
    } else {
      windows.set(key, valid);
    }
  }
}

/**
 * Check rate limit for a key. Returns null if allowed, or the number
 * of seconds to wait (Retry-After) if rate limited.
 */
export function checkRateLimit(key: string, config: RateLimiterConfig): number | null {
  const now = Date.now();
  const cutoff = now - config.windowMs;

  // Get the sliding window for this key
  const timestamps = windows.get(key);

  if (!timestamps) {
    // New key — reject if at capacity to prevent memory exhaustion
    if (windows.size >= MAX_TRACKED_KEYS) {
      return Math.ceil(config.windowMs / 1000);
    }
    windows.set(key, [now]);
    cleanupExpired();
    return null;
  }

  // Remove timestamps outside the window
  const valid = timestamps.filter((t) => t > cutoff);

  if (valid.length === 0) {
    // Window expired — record fresh
    windows.set(key, [now]);
    cleanupExpired();
    return null;
  }

  if (valid.length >= config.maxRequests) {
    // Rate limited — calculate Retry-After from the oldest entry in the window
    windows.set(key, valid);
    const oldestInWindow = valid[0];
    const retryAfterMs = oldestInWindow + config.windowMs - now;
    return Math.max(1, Math.ceil(retryAfterMs / 1000));
  }

  // Allow — record this request
  valid.push(now);
  windows.set(key, valid);
  cleanupExpired();
  return null;
}

/**
 * Reset all rate limit state. Test-only.
 */
export function resetRateLimits(): void {
  windows.clear();
  lastCleanup = 0;
}

type HonoContext = Context<{ Bindings: Env; Variables: AppVariables }>;

/**
 * Create a Hono middleware that rate-limits by agent_id from the request body.
 */
export function rateLimitByAgent(config: RateLimiterConfig): MiddlewareHandler {
  return async (c: HonoContext, next) => {
    // Clone the request to read body without consuming it
    const body = await c.req.raw
      .clone()
      .json()
      .catch(() => null);
    const agentId = (body as { agent_id?: string } | null)?.agent_id;
    if (!agentId) {
      // No agent_id — let the route handler return a validation error
      await next();
      return;
    }

    const retryAfter = checkRateLimit(`agent:${agentId}`, config);
    if (retryAfter !== null) {
      c.header('Retry-After', String(retryAfter));
      return c.json<ErrorResponse>(
        { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } },
        429,
      );
    }

    await next();
  };
}

/**
 * Create a Hono middleware that rate-limits by client IP.
 * Use `prefix` to isolate rate limit buckets per endpoint (e.g., 'auth:device').
 */
export function rateLimitByIP(config: RateLimiterConfig & { prefix?: string }): MiddlewareHandler {
  return async (c: HonoContext, next) => {
    const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
    const key = config.prefix ? `${config.prefix}:ip:${ip}` : `ip:${ip}`;

    const retryAfter = checkRateLimit(key, config);
    if (retryAfter !== null) {
      c.header('Retry-After', String(retryAfter));
      return c.json<ErrorResponse>(
        { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } },
        429,
      );
    }

    await next();
  };
}

/**
 * Create a Hono middleware that rate-limits by authenticated identity.
 *
 * Uses the verified `github_user_id` from OAuth (set by requireOAuth middleware)
 * as the rate limit key. This allows multiple CLI instances from the same IP
 * to each get their own rate limit budget when authenticated as different users,
 * while still sharing a budget per-user.
 *
 * Falls back to IP-based limiting if no verified identity is present.
 *
 * IMPORTANT: This middleware must run AFTER requireOAuth() so that
 * `verifiedIdentity` is available in the Hono context.
 */
export function rateLimitByIdentity(
  config: RateLimiterConfig & { prefix?: string },
): MiddlewareHandler {
  return async (c: HonoContext, next) => {
    const identity = c.get('verifiedIdentity');
    let key: string;
    if (identity?.github_user_id) {
      key = config.prefix
        ? `${config.prefix}:user:${identity.github_user_id}`
        : `user:${identity.github_user_id}`;
    } else {
      // Fallback to IP if no identity (shouldn't happen after requireOAuth)
      const ip = c.req.header('CF-Connecting-IP') ?? c.req.header('X-Forwarded-For') ?? 'unknown';
      key = config.prefix ? `${config.prefix}:ip:${ip}` : `ip:${ip}`;
    }

    const retryAfter = checkRateLimit(key, config);
    if (retryAfter !== null) {
      c.header('Retry-After', String(retryAfter));
      return c.json<ErrorResponse>(
        { error: { code: 'RATE_LIMITED', message: 'Rate limit exceeded' } },
        429,
      );
    }

    await next();
  };
}
