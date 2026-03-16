import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { apiFetch } from '../api.js';

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('apiFetch', () => {
  it('fetches data from the given path', async () => {
    const mockData = { result: 'ok' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockData),
      }),
    );

    const result = await apiFetch('/api/test');
    expect(result).toEqual(mockData);
    expect(fetch).toHaveBeenCalledWith('/api/test', undefined);
  });

  it('uses NEXT_PUBLIC_API_URL when set', async () => {
    vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.com');
    // Re-import to pick up the env change
    vi.resetModules();
    const { apiFetch: freshApiFetch } = await import('../api.js');

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      }),
    );

    await freshApiFetch('/api/test');
    expect(fetch).toHaveBeenCalledWith('https://api.example.com/api/test', undefined);
  });

  it('throws on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
        statusText: 'Not Found',
      }),
    );

    await expect(apiFetch('/api/missing')).rejects.toThrow('API error: 404 Not Found');
  });

  it('passes init options to fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({}),
      }),
    );

    const init = { method: 'POST', body: '{}' };
    await apiFetch('/api/test', init);
    expect(fetch).toHaveBeenCalledWith('/api/test', init);
  });
});
