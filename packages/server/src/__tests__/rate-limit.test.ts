import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env, AppVariables } from '../types.js';
import type { VerifiedIdentity } from '@opencara/shared';
import {
  checkRateLimit,
  resetRateLimits,
  rateLimitByIdentity,
  rateLimitByIP,
} from '../middleware/rate-limit.js';

describe('Rate Limiter', () => {
  beforeEach(() => {
    resetRateLimits();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('checkRateLimit', () => {
    it('allows requests under the limit', () => {
      const config = { maxRequests: 3, windowMs: 60_000 };
      expect(checkRateLimit('key1', config)).toBeNull();
      expect(checkRateLimit('key1', config)).toBeNull();
      expect(checkRateLimit('key1', config)).toBeNull();
    });

    it('returns Retry-After when limit exceeded', () => {
      const config = { maxRequests: 2, windowMs: 60_000 };
      expect(checkRateLimit('key1', config)).toBeNull();
      expect(checkRateLimit('key1', config)).toBeNull();
      const retryAfter = checkRateLimit('key1', config);
      expect(retryAfter).not.toBeNull();
      expect(retryAfter).toBeGreaterThan(0);
      expect(retryAfter).toBeLessThanOrEqual(60);
    });

    it('isolates keys independently', () => {
      const config = { maxRequests: 1, windowMs: 60_000 };
      expect(checkRateLimit('key-a', config)).toBeNull();
      expect(checkRateLimit('key-b', config)).toBeNull();
      // key-a is now limited, key-b is still under
      expect(checkRateLimit('key-a', config)).not.toBeNull();
    });

    it('resets after resetRateLimits', () => {
      const config = { maxRequests: 1, windowMs: 60_000 };
      expect(checkRateLimit('key1', config)).toBeNull();
      expect(checkRateLimit('key1', config)).not.toBeNull();
      resetRateLimits();
      expect(checkRateLimit('key1', config)).toBeNull();
    });

    it('allows requests after window expires', () => {
      const config = { maxRequests: 1, windowMs: 1_000 };
      expect(checkRateLimit('key1', config)).toBeNull();
      expect(checkRateLimit('key1', config)).not.toBeNull();

      // Advance past the window
      vi.advanceTimersByTime(1_100);
      expect(checkRateLimit('key1', config)).toBeNull();
    });

    it('rejects new keys when at MAX_TRACKED_KEYS capacity', () => {
      const config = { maxRequests: 100, windowMs: 60_000 };
      // Fill up to capacity (10,000 keys)
      for (let i = 0; i < 10_000; i++) {
        expect(checkRateLimit(`flood-${i}`, config)).toBeNull();
      }
      // New key should be rejected
      const retryAfter = checkRateLimit('new-key', config);
      expect(retryAfter).not.toBeNull();
      expect(retryAfter).toBe(60); // windowMs / 1000
    });
  });

  describe('rateLimitByIdentity middleware', () => {
    function createTestApp(identity?: VerifiedIdentity) {
      const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      // Simulate OAuth middleware setting the verified identity
      app.use('*', async (c, next) => {
        if (identity) c.set('verifiedIdentity', identity);
        await next();
      });
      app.post(
        '/test',
        rateLimitByIdentity({ maxRequests: 2, windowMs: 60_000, prefix: 'test' }),
        (c) => c.json({ ok: true }),
      );
      return app;
    }

    it('rate limits by github_user_id when identity is present', async () => {
      const app = createTestApp({ github_user_id: 42, github_username: 'alice', verified_at: 0 });
      const req = () =>
        app.request('/test', { method: 'POST' }, { GITHUB_WEBHOOK_SECRET: '' } as Env);
      expect((await req()).status).toBe(200);
      expect((await req()).status).toBe(200);
      expect((await req()).status).toBe(429);
    });

    it('different users get separate rate limit budgets', async () => {
      const appA = createTestApp({ github_user_id: 1, github_username: 'a', verified_at: 0 });
      const appB = createTestApp({ github_user_id: 2, github_username: 'b', verified_at: 0 });
      // Exhaust user 1's budget
      const reqA = () =>
        appA.request('/test', { method: 'POST' }, { GITHUB_WEBHOOK_SECRET: '' } as Env);
      expect((await reqA()).status).toBe(200);
      expect((await reqA()).status).toBe(200);
      expect((await reqA()).status).toBe(429);
      // User 2 should still be allowed
      const reqB = () =>
        appB.request('/test', { method: 'POST' }, { GITHUB_WEBHOOK_SECRET: '' } as Env);
      expect((await reqB()).status).toBe(200);
    });

    it('falls back to IP when no identity is present', async () => {
      const app = createTestApp(); // no identity
      const req = () =>
        app.request('/test', { method: 'POST' }, { GITHUB_WEBHOOK_SECRET: '' } as Env);
      expect((await req()).status).toBe(200);
      expect((await req()).status).toBe(200);
      expect((await req()).status).toBe(429);
    });
  });

  describe('rateLimitByIP middleware', () => {
    function createTestApp() {
      const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
      app.post(
        '/test',
        rateLimitByIP({ maxRequests: 2, windowMs: 60_000, prefix: 'ip-test' }),
        (c) => c.json({ ok: true }),
      );
      return app;
    }

    it('rate limits by IP address', async () => {
      const app = createTestApp();
      const req = () =>
        app.request('/test', { method: 'POST' }, { GITHUB_WEBHOOK_SECRET: '' } as Env);
      expect((await req()).status).toBe(200);
      expect((await req()).status).toBe(200);
      expect((await req()).status).toBe(429);
    });
  });
});
