import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient, HttpError } from '../http.js';

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
});
