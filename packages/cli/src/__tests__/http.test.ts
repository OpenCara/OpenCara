import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient, HttpError, UpgradeRequiredError, API_TIMEOUT_MS } from '../http.js';

describe('ApiClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends Content-Type header', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    });

    const client = new ApiClient('https://api.test.com');
    await client.get('/test');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.test.com/test',
      expect.objectContaining({
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
        }),
      }),
    );
    const calledHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(calledHeaders).not.toHaveProperty('Authorization');
  });

  it('throws HttpError with structured error message on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () =>
        Promise.resolve({ error: { code: 'UNAUTHORIZED', message: 'Invalid webhook signature' } }),
    });

    const client = new ApiClient('https://api.test.com');
    const err = await client.get('/test').catch((e: HttpError) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toBe('Invalid webhook signature');
    expect(err.errorCode).toBe('UNAUTHORIZED');
    expect(err.status).toBe(401);
  });

  it('throws HttpError with structured error message on 500', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () =>
        Promise.resolve({
          error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' },
        }),
    });

    const client = new ApiClient('https://api.test.com');
    const err = await client.get('/test').catch((e: HttpError) => e);
    expect(err).toBeInstanceOf(HttpError);
    expect(err.message).toBe('Internal Server Error');
    expect(err.errorCode).toBe('INTERNAL_ERROR');
  });

  it('post sends JSON body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: '123' }),
    });

    const client = new ApiClient('https://api.test.com');
    const result = await client.post('/agents', { model: 'gpt-4' });

    expect(result).toEqual({ id: '123' });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.test.com/agents',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ model: 'gpt-4' }),
      }),
    );
  });

  it('HttpError has correct status and optional errorCode', async () => {
    const err = new HttpError(403, 'Forbidden');
    expect(err.status).toBe(403);
    expect(err.message).toBe('Forbidden');
    expect(err.name).toBe('HttpError');
    expect(err.errorCode).toBeUndefined();

    const err2 = new HttpError(429, 'Rate limit exceeded', 'RATE_LIMITED');
    expect(err2.status).toBe(429);
    expect(err2.errorCode).toBe('RATE_LIMITED');
  });

  it('falls back to generic message when error response is not JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('not json')),
    });

    const client = new ApiClient('https://api.test.com');
    const err = await client.get('/test').catch((e: HttpError) => e);
    expect(err.message).toBe('HTTP 502');
    expect(err.errorCode).toBeUndefined();
  });

  it('logs requests in debug mode', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ data: 'test' }),
    });

    const client = new ApiClient('https://api.test.com', true);
    await client.post('/tasks/poll', { agent_id: 'a1' });

    expect(debugSpy).toHaveBeenCalledWith('[ApiClient] POST /tasks/poll');
    expect(debugSpy).toHaveBeenCalledWith('[ApiClient] 200 OK (/tasks/poll)');
    debugSpy.mockRestore();
  });

  it('does not log when debug is disabled', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({}),
    });

    const client = new ApiClient('https://api.test.com', false);
    await client.get('/test');

    expect(debugSpy).not.toHaveBeenCalled();
    debugSpy.mockRestore();
  });

  it('logs error responses in debug mode', async () => {
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 404,
      json: () => Promise.resolve({ error: { code: 'TASK_NOT_FOUND', message: 'Task not found' } }),
    });

    const client = new ApiClient('https://api.test.com', true);
    await expect(client.get('/missing')).rejects.toThrow('Task not found');

    expect(debugSpy).toHaveBeenCalledWith('[ApiClient] GET /missing');
    expect(debugSpy).toHaveBeenCalledWith('[ApiClient] 404 Task not found (/missing)');
    debugSpy.mockRestore();
  });

  it('sends X-OpenCara-CLI-Version header when cliVersion is set', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    });

    const client = new ApiClient('https://api.test.com', { cliVersion: '1.2.3' });
    await client.get('/test');

    const calledHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(calledHeaders['X-OpenCara-CLI-Version']).toBe('1.2.3');
  });

  it('sends X-OpenCara-CLI-Version header on POST requests', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: '1' }),
    });

    const client = new ApiClient('https://api.test.com', { cliVersion: '0.14.0' });
    await client.post('/api/tasks/poll', { agent_id: 'a1' });

    const calledHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(calledHeaders['X-OpenCara-CLI-Version']).toBe('0.14.0');
  });

  it('does not send X-OpenCara-CLI-Version header when cliVersion is not set', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    });

    const client = new ApiClient('https://api.test.com');
    await client.get('/test');

    const calledHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(calledHeaders).not.toHaveProperty('X-OpenCara-CLI-Version');
  });

  it('throws UpgradeRequiredError on 426 response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 426,
      json: () =>
        Promise.resolve({
          error: { code: 'CLI_OUTDATED', message: 'CLI version too old' },
          minimum_version: '0.15.0',
        }),
    });

    const client = new ApiClient('https://api.test.com', { cliVersion: '0.14.0' });
    const err = await client.get('/test').catch((e: UpgradeRequiredError) => e);
    expect(err).toBeInstanceOf(UpgradeRequiredError);
    expect(err.currentVersion).toBe('0.14.0');
    expect(err.minimumVersion).toBe('0.15.0');
    expect(err.message).toContain('0.14.0');
    expect(err.message).toContain('0.15.0');
    expect(err.message).toContain('npm update -g opencara');
  });

  it('throws UpgradeRequiredError on 426 even without minimum_version', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 426,
      json: () => Promise.reject(new Error('not json')),
    });

    const client = new ApiClient('https://api.test.com', { cliVersion: '0.14.0' });
    const err = await client.get('/test').catch((e: UpgradeRequiredError) => e);
    expect(err).toBeInstanceOf(UpgradeRequiredError);
    expect(err.currentVersion).toBe('0.14.0');
    expect(err.minimumVersion).toBeUndefined();
  });

  it('throws UpgradeRequiredError with "unknown" version when cliVersion not set', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 426,
      json: () => Promise.resolve({ minimum_version: '0.15.0' }),
    });

    const client = new ApiClient('https://api.test.com');
    const err = await client.get('/test').catch((e: UpgradeRequiredError) => e);
    expect(err).toBeInstanceOf(UpgradeRequiredError);
    expect(err.currentVersion).toBe('unknown');
    expect(err.minimumVersion).toBe('0.15.0');
  });

  it('sends Cloudflare-Workers-Version-Overrides header when versionOverride is set', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    });

    const client = new ApiClient('https://api.test.com', {
      versionOverride: 'opencara-server=abc123',
    });
    await client.get('/test');

    const calledHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(calledHeaders['Cloudflare-Workers-Version-Overrides']).toBe('opencara-server=abc123');
  });

  it('sends Cloudflare-Workers-Version-Overrides header on POST requests', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: '1' }),
    });

    const client = new ApiClient('https://api.test.com', {
      versionOverride: 'opencara-server=xyz789',
    });
    await client.post('/api/tasks/poll', { agent_id: 'a1' });

    const calledHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(calledHeaders['Cloudflare-Workers-Version-Overrides']).toBe('opencara-server=xyz789');
  });

  it('does not send Cloudflare-Workers-Version-Overrides header when versionOverride is not set', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    });

    const client = new ApiClient('https://api.test.com');
    await client.get('/test');

    const calledHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(calledHeaders).not.toHaveProperty('Cloudflare-Workers-Version-Overrides');
  });

  it('does not send Cloudflare-Workers-Version-Overrides header when versionOverride is null', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    });

    const client = new ApiClient('https://api.test.com', { versionOverride: null });
    await client.get('/test');

    const calledHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(calledHeaders).not.toHaveProperty('Cloudflare-Workers-Version-Overrides');
  });

  it('UpgradeRequiredError has correct name and properties', () => {
    const err = new UpgradeRequiredError('0.14.0', '0.15.0');
    expect(err.name).toBe('UpgradeRequiredError');
    expect(err.currentVersion).toBe('0.14.0');
    expect(err.minimumVersion).toBe('0.15.0');

    const err2 = new UpgradeRequiredError('0.14.0');
    expect(err2.minimumVersion).toBeUndefined();
    expect(err2.message).not.toContain('Minimum required');
  });

  it('sends Authorization header when authToken is set', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    });

    const client = new ApiClient('https://api.test.com', { authToken: 'my-token' });
    await client.get('/test');

    const calledHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].headers;
    expect(calledHeaders['Authorization']).toBe('Bearer my-token');
  });

  it('exposes currentToken getter that reflects refreshed token', async () => {
    const client = new ApiClient('https://api.test.com', { authToken: 'initial-token' });
    expect(client.currentToken).toBe('initial-token');

    const expiredResponse = {
      ok: false,
      status: 401,
      json: () =>
        Promise.resolve({
          error: { code: 'AUTH_TOKEN_EXPIRED', message: 'Token has expired' },
        }),
    };
    const successResponse = {
      ok: true,
      json: () => Promise.resolve({ data: 'ok' }),
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(expiredResponse)
      .mockResolvedValueOnce(successResponse);

    const onTokenRefresh = vi.fn().mockResolvedValue('refreshed-token');
    const client2 = new ApiClient('https://api.test.com', {
      authToken: 'old-token',
      onTokenRefresh,
    });

    await client2.get('/test');
    expect(client2.currentToken).toBe('refreshed-token');
  });

  describe('AUTH_TOKEN_EXPIRED token refresh', () => {
    const expiredResponse = {
      ok: false,
      status: 401,
      json: () =>
        Promise.resolve({
          error: { code: 'AUTH_TOKEN_EXPIRED', message: 'Token has expired' },
        }),
    };

    const successResponse = {
      ok: true,
      json: () => Promise.resolve({ data: 'refreshed' }),
    };

    it('refreshes token and retries on AUTH_TOKEN_EXPIRED', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(expiredResponse)
        .mockResolvedValueOnce(successResponse);

      const onTokenRefresh = vi.fn().mockResolvedValue('new-token');
      const client = new ApiClient('https://api.test.com', {
        authToken: 'old-token',
        onTokenRefresh,
      });

      const result = await client.get<{ data: string }>('/test');

      expect(result).toEqual({ data: 'refreshed' });
      expect(onTokenRefresh).toHaveBeenCalledOnce();
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
      // Second call should use the new token
      const retryHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1][1].headers;
      expect(retryHeaders['Authorization']).toBe('Bearer new-token');
    });

    it('refreshes token and retries POST with same body', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(expiredResponse)
        .mockResolvedValueOnce(successResponse);

      const onTokenRefresh = vi.fn().mockResolvedValue('new-token');
      const client = new ApiClient('https://api.test.com', {
        authToken: 'old-token',
        onTokenRefresh,
      });

      const result = await client.post<{ data: string }>('/tasks/poll', { agent_id: 'a1' });

      expect(result).toEqual({ data: 'refreshed' });
      const retryCall = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[1];
      expect(retryCall[1].method).toBe('POST');
      expect(retryCall[1].body).toBe(JSON.stringify({ agent_id: 'a1' }));
      expect(retryCall[1].headers['Authorization']).toBe('Bearer new-token');
    });

    it('throws HttpError when token refresh fails', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(expiredResponse);

      const onTokenRefresh = vi.fn().mockRejectedValue(new Error('refresh failed'));
      const client = new ApiClient('https://api.test.com', {
        authToken: 'old-token',
        onTokenRefresh,
      });

      const err = await client.get('/test').catch((e: HttpError) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(401);
      expect(err.errorCode).toBe('AUTH_TOKEN_EXPIRED');
    });

    it('does not attempt refresh when onTokenRefresh is not set', async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(expiredResponse);

      const client = new ApiClient('https://api.test.com', { authToken: 'old-token' });

      const err = await client.get('/test').catch((e: HttpError) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(401);
      expect(err.errorCode).toBe('AUTH_TOKEN_EXPIRED');
      expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    });

    it('does not attempt second refresh if retry also fails with expired token', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValueOnce(expiredResponse)
        .mockResolvedValueOnce(expiredResponse);

      const onTokenRefresh = vi.fn().mockResolvedValue('new-token');
      const client = new ApiClient('https://api.test.com', {
        authToken: 'old-token',
        onTokenRefresh,
      });

      const err = await client.get('/test').catch((e: HttpError) => e);
      expect(err).toBeInstanceOf(HttpError);
      expect(err.status).toBe(401);
      expect(err.errorCode).toBe('AUTH_TOKEN_EXPIRED');
      // Only one refresh attempt
      expect(onTokenRefresh).toHaveBeenCalledOnce();
      expect(globalThis.fetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('timeout', () => {
    it('passes AbortController signal to fetch calls', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: 'test' }),
      });

      const client = new ApiClient('https://api.test.com');
      await client.get('/test');

      const calledInit = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(calledInit.signal).toBeInstanceOf(AbortSignal);
    });

    it('uses default timeout of API_TIMEOUT_MS', () => {
      expect(API_TIMEOUT_MS).toBe(30_000);
    });

    it('accepts custom timeoutMs', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ data: 'test' }),
      });

      const client = new ApiClient('https://api.test.com', { timeoutMs: 5000 });
      await client.get('/test');

      const calledInit = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(calledInit.signal).toBeInstanceOf(AbortSignal);
    });

    it('throws on timeout (AbortError propagated from fetch)', async () => {
      globalThis.fetch = vi
        .fn()
        .mockRejectedValue(new DOMException('The operation was aborted.', 'AbortError'));

      const client = new ApiClient('https://api.test.com', { timeoutMs: 1 });
      await expect(client.get('/test')).rejects.toThrow('aborted');
    });

    it('passes AbortController signal to POST fetch calls', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ id: '1' }),
      });

      const client = new ApiClient('https://api.test.com');
      await client.post('/test', { data: 1 });

      const calledInit = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1];
      expect(calledInit.signal).toBeInstanceOf(AbortSignal);
    });
  });
});
