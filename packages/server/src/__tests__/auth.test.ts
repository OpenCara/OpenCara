import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { requireApiKey } from '../middleware/auth.js';
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
  });

  describe('unprotected routes', () => {
    it('health endpoint is not affected by auth middleware', async () => {
      const { app, env } = createTestApp('key-abc');
      const res = await app.request('/health', { method: 'GET' }, env);
      expect(res.status).toBe(200);
    });
  });
});
