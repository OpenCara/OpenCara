import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { requireApiKey, resetKeySetCache } from '../middleware/auth.js';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import { resetRateLimits } from '../middleware/rate-limit.js';
import type { Env, AppVariables } from '../types.js';

function createTestApp(apiKeys?: string) {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
  app.use('/api/tasks/*', requireApiKey());
  app.post('/api/tasks/poll', (c) => c.json({ ok: true }));
  app.get('/health', (c) => c.json({ status: 'ok' }));

  const env: Partial<Env> = {
    GITHUB_WEBHOOK_SECRET: 'test',
    GITHUB_APP_ID: '1',
    GITHUB_APP_PRIVATE_KEY: 'key',
    WEB_URL: 'https://test.com',
  };
  if (apiKeys !== undefined) {
    env.API_KEYS = apiKeys;
  }

  return { app, env };
}

describe('Auth Middleware', () => {
  beforeEach(() => {
    resetKeySetCache();
  });

  describe('open mode (no API_KEYS)', () => {
    it('allows requests without Authorization header', async () => {
      const { app, env } = createTestApp();
      const res = await app.request(
        '/api/tasks/poll',
        { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
        env,
      );
      expect(res.status).toBe(200);
    });

    it('allows requests when API_KEYS is empty string', async () => {
      const { app, env } = createTestApp('');
      const res = await app.request(
        '/api/tasks/poll',
        { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
        env,
      );
      expect(res.status).toBe(200);
    });

    it('allows requests when API_KEYS is whitespace only', async () => {
      const { app, env } = createTestApp('  , , ');
      const res = await app.request(
        '/api/tasks/poll',
        { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
        env,
      );
      expect(res.status).toBe(200);
    });
  });

  describe('auth mode (API_KEYS configured)', () => {
    it('rejects requests without Authorization header', async () => {
      const { app, env } = createTestApp('key-abc,key-def');
      const res = await app.request(
        '/api/tasks/poll',
        { method: 'POST', body: '{}', headers: { 'Content-Type': 'application/json' } },
        env,
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(body.error.message).toContain('Missing');
    });

    it('rejects requests with invalid token', async () => {
      const { app, env } = createTestApp('key-abc');
      const res = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          body: '{}',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer wrong-key',
          },
        },
        env,
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(body.error.message).toContain('Invalid API key');
    });

    it('rejects requests with non-Bearer auth', async () => {
      const { app, env } = createTestApp('key-abc');
      const res = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          body: '{}',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Basic dXNlcjpwYXNz',
          },
        },
        env,
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as { error: { code: string; message: string } };
      expect(body.error.code).toBe('UNAUTHORIZED');
      expect(body.error.message).toContain('Invalid Authorization header format');
    });

    it('allows requests with valid token', async () => {
      const { app, env } = createTestApp('key-abc,key-def');
      const res = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          body: '{}',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer key-abc',
          },
        },
        env,
      );
      expect(res.status).toBe(200);
    });

    it('allows any valid key from comma-separated list', async () => {
      const { app, env } = createTestApp('key-abc, key-def, key-ghi');
      const res = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          body: '{}',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer key-def',
          },
        },
        env,
      );
      expect(res.status).toBe(200);
    });

    it('handles single key', async () => {
      const { app, env } = createTestApp('single-key');
      const res = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          body: '{}',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer single-key',
          },
        },
        env,
      );
      expect(res.status).toBe(200);
    });

    it('trims trailing whitespace from token', async () => {
      const { app, env } = createTestApp('key-abc');
      const res = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          body: '{}',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer key-abc  ',
          },
        },
        env,
      );
      expect(res.status).toBe(200);
    });
  });

  describe('unprotected routes', () => {
    it('health endpoint is not affected by auth middleware', async () => {
      const { app, env } = createTestApp('key-abc');
      const res = await app.request('/health', { method: 'GET' }, env);
      expect(res.status).toBe(200);
    });
  });

  describe('integration with real taskRoutes', () => {
    const mockEnv: Env = {
      GITHUB_WEBHOOK_SECRET: 'test-secret',
      GITHUB_APP_ID: '12345',
      GITHUB_APP_PRIVATE_KEY: 'test-key',
      WEB_URL: 'https://test.com',
      API_KEYS: 'valid-key-1,valid-key-2',
    };

    beforeEach(() => {
      resetRateLimits();
    });

    it('rejects unauthenticated poll on real app', async () => {
      const app = createApp(new MemoryDataStore());
      const res = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          body: JSON.stringify({ agent_id: 'test-agent' }),
          headers: { 'Content-Type': 'application/json' },
        },
        mockEnv,
      );
      expect(res.status).toBe(401);
    });

    it('rejects unauthenticated claim on real app', async () => {
      const app = createApp(new MemoryDataStore());
      const res = await app.request(
        '/api/tasks/some-task/claim',
        {
          method: 'POST',
          body: JSON.stringify({ agent_id: 'test-agent', role: 'review' }),
          headers: { 'Content-Type': 'application/json' },
        },
        mockEnv,
      );
      expect(res.status).toBe(401);
    });

    it('rejects unauthenticated result on real app', async () => {
      const app = createApp(new MemoryDataStore());
      const res = await app.request(
        '/api/tasks/some-task/result',
        {
          method: 'POST',
          body: JSON.stringify({ agent_id: 'test-agent', type: 'review', review_text: 'ok' }),
          headers: { 'Content-Type': 'application/json' },
        },
        mockEnv,
      );
      expect(res.status).toBe(401);
    });

    it('allows authenticated poll on real app', async () => {
      const app = createApp(new MemoryDataStore());
      const res = await app.request(
        '/api/tasks/poll',
        {
          method: 'POST',
          body: JSON.stringify({ agent_id: 'test-agent' }),
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer valid-key-1',
          },
        },
        mockEnv,
      );
      expect(res.status).toBe(200);
    });

    it('does not affect health endpoint', async () => {
      const app = createApp(new MemoryDataStore());
      const res = await app.request('/health', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(200);
    });

    it('does not affect registry endpoint', async () => {
      const app = createApp(new MemoryDataStore());
      const res = await app.request('/api/registry', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(200);
    });
  });
});
