import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import { resetRateLimits } from '../middleware/rate-limit.js';

const mockEnv = {
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: 'test-key',
  WEB_URL: 'https://test.com',
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-client-secret',
};

function makeApp() {
  return createApp(new MemoryDataStore());
}

function postDevice(app: ReturnType<typeof makeApp>, headers?: Record<string, string>) {
  return app.request(
    '/api/auth/device',
    { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
    mockEnv,
  );
}

function postDeviceToken(
  app: ReturnType<typeof makeApp>,
  body: unknown,
  headers?: Record<string, string>,
) {
  return app.request(
    '/api/auth/device/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    mockEnv,
  );
}

function postRefresh(
  app: ReturnType<typeof makeApp>,
  body: unknown,
  headers?: Record<string, string>,
) {
  return app.request(
    '/api/auth/refresh',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    },
    mockEnv,
  );
}

describe('Auth Routes', () => {
  let app: ReturnType<typeof makeApp>;
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetRateLimits();
    app = makeApp();
    fetchSpy = vi.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  // ── POST /api/auth/device ───────────────────────────────────

  describe('POST /api/auth/device', () => {
    it('initiates device flow and returns GitHub response', async () => {
      const ghResponse = {
        device_code: 'dc-123',
        user_code: 'ABCD-1234',
        verification_uri: 'https://github.com/login/device',
        expires_in: 900,
        interval: 5,
      };
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(ghResponse), { status: 200 }));

      const res = await postDevice(app);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(ghResponse);

      // Verify fetch was called with correct params
      expect(fetchSpy).toHaveBeenCalledWith(
        'https://github.com/login/device/code',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ client_id: 'test-client-id', scope: '' }),
        }),
      );
    });

    it('sends client_id from env, not from request', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'UC',
            verification_uri: 'u',
            expires_in: 900,
            interval: 5,
          }),
          { status: 200 },
        ),
      );

      await postDevice(app);

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(callBody.client_id).toBe('test-client-id');
    });

    it('returns 500 when GITHUB_CLIENT_ID is not configured', async () => {
      const envNoClient = { ...mockEnv, GITHUB_CLIENT_ID: undefined };
      const res = await app.request(
        '/api/auth/device',
        { method: 'POST', headers: { 'Content-Type': 'application/json' } },
        envNoClient,
      );
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('OAuth not configured');
    });

    it('returns 500 when GitHub API returns non-OK', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('Bad Request', { status: 400 }));

      const res = await postDevice(app);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('Failed to initiate device flow');
    });

    it('returns 500 on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('DNS resolution failed'));

      const res = await postDevice(app);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('Failed to initiate device flow');
    });

    it('returns 500 when GitHub returns invalid response shape', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ unexpected: 'data' }), { status: 200 }),
      );

      const res = await postDevice(app);
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('Invalid response from GitHub');
    });

    it('rate limits after 5 requests per IP per minute', async () => {
      const ghResponse = {
        device_code: 'dc',
        user_code: 'UC',
        verification_uri: 'u',
        expires_in: 900,
        interval: 5,
      };
      fetchSpy.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(ghResponse), { status: 200 })),
      );

      // 5 requests should succeed
      for (let i = 0; i < 5; i++) {
        const res = await postDevice(app);
        expect(res.status).toBe(200);
      }

      // 6th should be rate-limited
      const res = await postDevice(app);
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error.code).toBe('RATE_LIMITED');
      expect(res.headers.get('Retry-After')).toBeTruthy();
    });
  });

  // ── POST /api/auth/device/token ─────────────────────────────

  describe('POST /api/auth/device/token', () => {
    it('polls for token and returns access_token on success', async () => {
      const ghResponse = {
        access_token: 'ghu_abc123',
        refresh_token: 'ghr_xyz789',
        expires_in: 28800,
        token_type: 'bearer',
      };
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(ghResponse), { status: 200 }));

      const res = await postDeviceToken(app, { device_code: 'dc-123' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(ghResponse);

      // Verify fetch was called with correct params (includes client_secret when configured)
      const callBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(callBody.client_id).toBe('test-client-id');
      expect(callBody.client_secret).toBe('test-client-secret');
      expect(callBody.device_code).toBe('dc-123');
      expect(callBody.grant_type).toBe('urn:ietf:params:oauth:grant-type:device_code');
    });

    it('omits client_secret when GITHUB_CLIENT_SECRET is not configured', async () => {
      const ghResponse = {
        access_token: 'ghu_abc123',
        refresh_token: 'ghr_xyz789',
        expires_in: 28800,
        token_type: 'bearer',
      };
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(ghResponse), { status: 200 }));

      const envWithoutSecret = { ...mockEnv, GITHUB_CLIENT_SECRET: undefined };
      const res = await app.request(
        '/api/auth/device/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_code: 'dc-123' }),
        },
        envWithoutSecret as unknown as typeof mockEnv,
      );
      expect(res.status).toBe(200);

      const callBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(callBody.client_id).toBe('test-client-id');
      expect(callBody.client_secret).toBeUndefined();
    });

    it('returns token without refresh_token when GitHub omits it', async () => {
      const ghResponse = {
        access_token: 'ghu_abc123',
        expires_in: 28800,
        token_type: 'bearer',
        // no refresh_token
      };
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(ghResponse), { status: 200 }));

      const res = await postDeviceToken(app, { device_code: 'dc-123' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.access_token).toBe('ghu_abc123');
      expect(body.refresh_token).toBeUndefined();
    });

    it('returns authorization_pending error from GitHub', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'authorization_pending',
            error_description: 'The authorization request is still pending.',
          }),
          { status: 200 },
        ),
      );

      const res = await postDeviceToken(app, { device_code: 'dc-123' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBe('authorization_pending');
      expect(body.error_description).toBe('The authorization request is still pending.');
    });

    it('returns slow_down error from GitHub', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'slow_down' }), { status: 200 }),
      );

      const res = await postDeviceToken(app, { device_code: 'dc-123' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBe('slow_down');
    });

    it('returns expired_token error from GitHub', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'expired_token',
            error_description: 'The device code has expired.',
          }),
          { status: 200 },
        ),
      );

      const res = await postDeviceToken(app, { device_code: 'dc-expired' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBe('expired_token');
    });

    it('returns access_denied error from GitHub', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'access_denied' }), { status: 200 }),
      );

      const res = await postDeviceToken(app, { device_code: 'dc-denied' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBe('access_denied');
    });

    it('returns 400 for missing device_code', async () => {
      const res = await postDeviceToken(app, {});
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 400 for empty device_code', async () => {
      const res = await postDeviceToken(app, { device_code: '' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 400 for malformed JSON body', async () => {
      const res = await app.request(
        '/api/auth/device/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not json',
        },
        mockEnv,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 500 when GITHUB_CLIENT_ID is not configured', async () => {
      const envNoClient = { ...mockEnv, GITHUB_CLIENT_ID: undefined };
      const res = await app.request(
        '/api/auth/device/token',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ device_code: 'dc-123' }),
        },
        envNoClient,
      );
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });

    it('returns 500 when GitHub API returns non-OK', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

      const res = await postDeviceToken(app, { device_code: 'dc-123' });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });

    it('returns 500 on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Connection refused'));

      const res = await postDeviceToken(app, { device_code: 'dc-123' });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('Failed to poll for token');
    });

    it('returns 500 when GitHub returns invalid token response', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ unexpected: 'data' }), { status: 200 }),
      );

      const res = await postDeviceToken(app, { device_code: 'dc-123' });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('Invalid token response from GitHub');
    });

    it('rate limits after 10 requests per IP per minute', async () => {
      fetchSpy.mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify({ error: 'authorization_pending' }), { status: 200 }),
        ),
      );

      for (let i = 0; i < 10; i++) {
        const res = await postDeviceToken(app, { device_code: 'dc-123' });
        expect(res.status).toBe(200);
      }

      const res = await postDeviceToken(app, { device_code: 'dc-123' });
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error.code).toBe('RATE_LIMITED');
    });
  });

  // ── POST /api/auth/refresh ──────────────────────────────────

  describe('POST /api/auth/refresh', () => {
    it('refreshes token and returns new tokens', async () => {
      const ghResponse = {
        access_token: 'ghu_new123',
        refresh_token: 'ghr_new789',
        expires_in: 28800,
        token_type: 'bearer',
      };
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(ghResponse), { status: 200 }));

      const res = await postRefresh(app, { refresh_token: 'ghr_old456' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual(ghResponse);

      // Verify fetch was called with client_secret (server-side only)
      const callBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(callBody.client_id).toBe('test-client-id');
      expect(callBody.client_secret).toBe('test-client-secret');
      expect(callBody.grant_type).toBe('refresh_token');
      expect(callBody.refresh_token).toBe('ghr_old456');
    });

    it('client_secret is never exposed in the response', async () => {
      const ghResponse = {
        access_token: 'ghu_new',
        refresh_token: 'ghr_new',
        expires_in: 28800,
        token_type: 'bearer',
      };
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(ghResponse), { status: 200 }));

      const res = await postRefresh(app, { refresh_token: 'ghr_old' });
      const text = await res.text();
      expect(text).not.toContain('test-client-secret');
      expect(text).not.toContain('client_secret');
    });

    it('returns token without refresh_token when GitHub omits it', async () => {
      const ghResponse = {
        access_token: 'ghu_new',
        expires_in: 28800,
        token_type: 'bearer',
        // no refresh_token in response
      };
      fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify(ghResponse), { status: 200 }));

      const res = await postRefresh(app, { refresh_token: 'ghr_old' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.access_token).toBe('ghu_new');
      expect(body.refresh_token).toBeUndefined();
    });

    it('returns error when GitHub returns error response', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: 'bad_refresh_token',
            error_description: 'The refresh token is invalid.',
          }),
          { status: 200 },
        ),
      );

      const res = await postRefresh(app, { refresh_token: 'ghr_invalid' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.error).toBe('bad_refresh_token');
    });

    it('returns 400 for missing refresh_token', async () => {
      const res = await postRefresh(app, {});
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 400 for empty refresh_token', async () => {
      const res = await postRefresh(app, { refresh_token: '' });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 400 for malformed JSON body', async () => {
      const res = await app.request(
        '/api/auth/refresh',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: 'not json',
        },
        mockEnv,
      );
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error.code).toBe('INVALID_REQUEST');
    });

    it('returns 500 when GITHUB_CLIENT_ID is not configured', async () => {
      const envNoClient = { ...mockEnv, GITHUB_CLIENT_ID: undefined };
      const res = await app.request(
        '/api/auth/refresh',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: 'ghr_old' }),
        },
        envNoClient,
      );
      expect(res.status).toBe(500);
    });

    it('returns 500 when GITHUB_CLIENT_SECRET is not configured', async () => {
      const envNoSecret = { ...mockEnv, GITHUB_CLIENT_SECRET: undefined };
      const res = await app.request(
        '/api/auth/refresh',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: 'ghr_old' }),
        },
        envNoSecret,
      );
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('OAuth not configured');
    });

    it('returns 500 when GitHub API returns non-OK', async () => {
      fetchSpy.mockResolvedValueOnce(new Response('Server Error', { status: 500 }));

      const res = await postRefresh(app, { refresh_token: 'ghr_old' });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
    });

    it('returns 500 on network error', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('Connection timeout'));

      const res = await postRefresh(app, { refresh_token: 'ghr_old' });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('Failed to refresh token');
    });

    it('returns 500 when GitHub returns invalid token response', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(JSON.stringify({ unexpected: 'data' }), { status: 200 }),
      );

      const res = await postRefresh(app, { refresh_token: 'ghr_old' });
      expect(res.status).toBe(500);
      const body = await res.json();
      expect(body.error.code).toBe('INTERNAL_ERROR');
      expect(body.error.message).toBe('Invalid token response from GitHub');
    });

    it('rate limits after 10 requests per IP per minute', async () => {
      const ghResponse = {
        access_token: 'ghu_new',
        refresh_token: 'ghr_new',
        expires_in: 28800,
        token_type: 'bearer',
      };
      fetchSpy.mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(ghResponse), { status: 200 })),
      );

      for (let i = 0; i < 10; i++) {
        const res = await postRefresh(app, { refresh_token: 'ghr_old' });
        expect(res.status).toBe(200);
      }

      const res = await postRefresh(app, { refresh_token: 'ghr_old' });
      expect(res.status).toBe(429);
      const body = await res.json();
      expect(body.error.code).toBe('RATE_LIMITED');
    });
  });

  // ── Cross-endpoint checks ───────────────────────────────────

  describe('Security', () => {
    it('device flow init response never contains client_secret', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'UC',
            verification_uri: 'u',
            expires_in: 900,
            interval: 5,
          }),
          { status: 200 },
        ),
      );

      const res = await postDevice(app);
      const text = await res.text();
      expect(text).not.toContain('test-client-secret');
      expect(text).not.toContain('client_secret');
    });

    it('device token response never contains client_secret', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: 'ghu_abc',
            refresh_token: 'ghr_xyz',
            expires_in: 28800,
            token_type: 'bearer',
          }),
          { status: 200 },
        ),
      );

      const res = await postDeviceToken(app, { device_code: 'dc-123' });
      const text = await res.text();
      expect(text).not.toContain('test-client-secret');
      expect(text).not.toContain('client_secret');
    });

    it('rate limits are isolated between endpoints', async () => {
      const deviceResponse = {
        device_code: 'dc',
        user_code: 'UC',
        verification_uri: 'u',
        expires_in: 900,
        interval: 5,
      };
      const tokenResponse = { error: 'authorization_pending' };

      fetchSpy.mockImplementation((_url: string | URL | Request) => {
        const url = typeof _url === 'string' ? _url : _url.toString();
        if (url.includes('device/code')) {
          return Promise.resolve(new Response(JSON.stringify(deviceResponse), { status: 200 }));
        }
        return Promise.resolve(new Response(JSON.stringify(tokenResponse), { status: 200 }));
      });

      // Exhaust device init limit (5 requests)
      for (let i = 0; i < 5; i++) {
        const res = await postDevice(app);
        expect(res.status).toBe(200);
      }

      // Device init should be rate limited
      const res = await postDevice(app);
      expect(res.status).toBe(429);

      // But device token should still work (different bucket)
      const tokenRes = await postDeviceToken(app, { device_code: 'dc-123' });
      expect(tokenRes.status).toBe(200);
    });

    it('device init sends scope as empty string', async () => {
      fetchSpy.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            device_code: 'dc',
            user_code: 'UC',
            verification_uri: 'u',
            expires_in: 900,
            interval: 5,
          }),
          { status: 200 },
        ),
      );

      await postDevice(app);
      const callBody = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
      expect(callBody.scope).toBe('');
    });
  });
});
