import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiClient, HttpError } from '../http.js';

describe('ApiClient', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('adds Authorization header when apiKey is provided', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: 'test' }),
    });

    const client = new ApiClient('https://api.test.com', 'cr_mykey');
    await client.get('/test');

    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://api.test.com/test',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer cr_mykey',
          'Content-Type': 'application/json',
        }),
      }),
    );
  });

  it('omits Authorization header when no apiKey', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    });

    const client = new ApiClient('https://api.test.com');
    await client.get('/test');

    const calledHeaders = (globalThis.fetch as ReturnType<typeof vi.fn>).mock
      .calls[0][1].headers;
    expect(calledHeaders).not.toHaveProperty('Authorization');
  });

  it('throws HttpError with friendly message on 401', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: () => Promise.resolve({ error: 'Unauthorized' }),
    });

    const client = new ApiClient('https://api.test.com', 'cr_bad');
    await expect(client.get('/test')).rejects.toThrow(
      'Not authenticated. Run `opencrust login` first.',
    );
  });

  it('throws HttpError with server error message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.resolve({ error: 'Internal server error' }),
    });

    const client = new ApiClient('https://api.test.com', 'cr_key');
    await expect(client.get('/test')).rejects.toThrow('Internal server error');
  });

  it('post sends JSON body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ id: '123' }),
    });

    const client = new ApiClient('https://api.test.com', 'cr_key');
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

  it('HttpError has correct status', async () => {
    const err = new HttpError(403, 'Forbidden');
    expect(err.status).toBe(403);
    expect(err.message).toBe('Forbidden');
    expect(err.name).toBe('HttpError');
  });

  it('falls back to generic message when error response is not JSON', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      json: () => Promise.reject(new Error('not json')),
    });

    const client = new ApiClient('https://api.test.com', 'cr_key');
    await expect(client.get('/test')).rejects.toThrow('HTTP 502');
  });
});
