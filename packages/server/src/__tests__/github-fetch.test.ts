import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { githubFetch } from '../github/fetch.js';

describe('githubFetch', () => {
  const originalFetch = globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn();
    globalThis.fetch = fetchMock as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * Helper: start githubFetch, advance fake timers to flush all retry delays,
   * then return the result. This avoids real-time waits in tests.
   */
  async function fetchWithTimers(url: string, options?: Parameters<typeof githubFetch>[1]) {
    const promise = githubFetch(url, options);
    // Advance timers enough to cover max retries: 1s + 2s + 4s = 7s
    for (let i = 0; i < 10; i++) {
      await vi.advanceTimersByTimeAsync(4000);
    }
    return promise;
  }

  // ── Headers ───────────────────────────────────────────────

  describe('headers', () => {
    it('sets standard GitHub headers', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await fetchWithTimers('https://api.github.com/test');

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers['User-Agent']).toBe('OpenCara-Server');
      expect(init.headers['X-GitHub-Api-Version']).toBe('2022-11-28');
      expect(init.headers['Accept']).toBe('application/vnd.github+json');
    });

    it('sets Authorization header when token provided', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await fetchWithTimers('https://api.github.com/test', { token: 'ghs_abc123' });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers['Authorization']).toBe('Bearer ghs_abc123');
    });

    it('does not set Authorization header when no token', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await fetchWithTimers('https://api.github.com/test');

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers['Authorization']).toBeUndefined();
    });

    it('uses custom accept header', async () => {
      fetchMock.mockResolvedValueOnce(new Response('ok', { status: 200 }));

      await fetchWithTimers('https://api.github.com/test', {
        accept: 'application/vnd.github.diff',
      });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers['Accept']).toBe('application/vnd.github.diff');
    });

    it('sets Content-Type for POST requests', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await fetchWithTimers('https://api.github.com/test', {
        method: 'POST',
        body: JSON.stringify({ data: 1 }),
      });

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers['Content-Type']).toBe('application/json');
    });

    it('does not set Content-Type for GET requests', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await fetchWithTimers('https://api.github.com/test');

      const [, init] = fetchMock.mock.calls[0];
      expect(init.headers['Content-Type']).toBeUndefined();
    });
  });

  // ── Successful responses ──────────────────────────────────

  describe('successful responses', () => {
    it('returns response on 200', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

      const res = await fetchWithTimers('https://api.github.com/test');

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('returns response on 201', async () => {
      fetchMock.mockResolvedValueOnce(new Response('created', { status: 201 }));

      const res = await fetchWithTimers('https://api.github.com/test', { method: 'POST' });

      expect(res.status).toBe(201);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // ── Non-retryable errors ──────────────────────────────────

  describe('non-retryable errors', () => {
    it('does NOT retry 400 Bad Request', async () => {
      fetchMock.mockResolvedValueOnce(new Response('bad', { status: 400 }));

      const res = await fetchWithTimers('https://api.github.com/test');

      expect(res.status).toBe(400);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry 401 Unauthorized', async () => {
      fetchMock.mockResolvedValueOnce(new Response('unauth', { status: 401 }));

      const res = await fetchWithTimers('https://api.github.com/test');

      expect(res.status).toBe(401);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry 403 Forbidden', async () => {
      fetchMock.mockResolvedValueOnce(new Response('forbidden', { status: 403 }));

      const res = await fetchWithTimers('https://api.github.com/test');

      expect(res.status).toBe(403);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry 404 Not Found', async () => {
      fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }));

      const res = await fetchWithTimers('https://api.github.com/test');

      expect(res.status).toBe(404);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('does NOT retry 422 Unprocessable Entity', async () => {
      fetchMock.mockResolvedValueOnce(new Response('invalid', { status: 422 }));

      const res = await fetchWithTimers('https://api.github.com/test');

      expect(res.status).toBe(422);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });

  // ── Retryable errors ──────────────────────────────────────

  describe('retryable errors', () => {
    it('retries on 500 Internal Server Error and succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('error', { status: 500 }))
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

      const res = await fetchWithTimers('https://api.github.com/test');

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries on 502 Bad Gateway and succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('error', { status: 502 }))
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

      const res = await fetchWithTimers('https://api.github.com/test');

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries on 503 Service Unavailable and succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('error', { status: 503 }))
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

      const res = await fetchWithTimers('https://api.github.com/test');

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries on 429 Rate Limit and succeeds', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

      const res = await fetchWithTimers('https://api.github.com/test');

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('returns error response after all retries exhausted (4 attempts total)', async () => {
      fetchMock.mockResolvedValue(new Response('error', { status: 500 }));

      const res = await fetchWithTimers('https://api.github.com/test');

      expect(res.status).toBe(500);
      // 1 initial + 3 retries = 4 total
      expect(fetchMock).toHaveBeenCalledTimes(4);
    });

    it('applies jitter to retry delays', async () => {
      vi.useRealTimers();

      try {
        const delays: number[] = [];
        const origSetTimeout = globalThis.setTimeout;
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: TimerHandler, ms?: number) => {
          delays.push(ms ?? 0);
          return origSetTimeout(cb, 0);
        });

        fetchMock
          .mockResolvedValueOnce(new Response('error', { status: 500 }))
          .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

        const res = await githubFetch('https://api.github.com/test');

        expect(res.status).toBe(200);
        // Filter out timeout timers (30000ms) — only check retry delay timers
        const retryDelays = delays.filter((d) => d < 10_000);
        expect(retryDelays).toHaveLength(1);
        // Base delay is 1000ms, with ±30% jitter → 700-1300
        expect(retryDelays[0]).toBeGreaterThanOrEqual(700);
        expect(retryDelays[0]).toBeLessThanOrEqual(1300);
      } finally {
        vi.useFakeTimers();
      }
    });

    it('respects Retry-After header (seconds)', async () => {
      fetchMock
        .mockResolvedValueOnce(
          new Response('rate limited', {
            status: 429,
            headers: { 'Retry-After': '2' },
          }),
        )
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

      const res = await fetchWithTimers('https://api.github.com/test');

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });

  // ── Network errors ────────────────────────────────────────

  describe('network errors', () => {
    it('retries on network error and succeeds', async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

      const res = await fetchWithTimers('https://api.github.com/test');

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws after all network error retries exhausted', async () => {
      vi.useRealTimers();

      // Use real timers with mockRejectedValueOnce (each call creates a fresh rejection)
      fetchMock
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockRejectedValueOnce(new TypeError('fetch failed'));

      await expect(githubFetch('https://api.github.com/test')).rejects.toThrow('fetch failed');

      // 1 initial + 3 retries = 4 total
      expect(fetchMock).toHaveBeenCalledTimes(4);

      // Re-enable fake timers for subsequent tests
      vi.useFakeTimers();
    }, 15000);

    it('retries network error then handles 500 retry', async () => {
      fetchMock
        .mockRejectedValueOnce(new TypeError('fetch failed'))
        .mockResolvedValueOnce(new Response('error', { status: 500 }))
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

      const res = await fetchWithTimers('https://api.github.com/test');

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  // ── Timeout behavior ─────────────────────────────────────

  describe('timeout', () => {
    it('passes AbortController signal to each fetch attempt', async () => {
      fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

      await fetchWithTimers('https://api.github.com/test');

      const [, init] = fetchMock.mock.calls[0];
      expect(init.signal).toBeInstanceOf(AbortSignal);
    });

    it('retries on timeout (abort error) like a network error', async () => {
      fetchMock
        .mockRejectedValueOnce(new DOMException('The operation was aborted.', 'AbortError'))
        .mockResolvedValueOnce(new Response('{"ok":true}', { status: 200 }));

      const res = await fetchWithTimers('https://api.github.com/test');

      expect(res.status).toBe(200);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('uses custom timeoutMs when provided', async () => {
      vi.useRealTimers();
      try {
        const delays: number[] = [];
        const origSetTimeout = globalThis.setTimeout;
        vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: TimerHandler, ms?: number) => {
          delays.push(ms ?? 0);
          return origSetTimeout(cb, 0);
        });

        fetchMock.mockResolvedValueOnce(new Response('{}', { status: 200 }));

        await githubFetch('https://api.github.com/test', { timeoutMs: 5000 });

        // The first setTimeout should be the timeout timer with our custom value
        expect(delays).toContain(5000);
      } finally {
        vi.useFakeTimers();
      }
    });
  });

  // ── Integration with callers ──────────────────────────────

  describe('caller integration', () => {
    it('postPrComment succeeds after transient 502', async () => {
      fetchMock
        .mockResolvedValueOnce(new Response('Bad Gateway', { status: 502 }))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({ html_url: 'https://github.com/test/test/pull/1#comment-1' }),
            { status: 200 },
          ),
        );

      const response = await fetchWithTimers(
        'https://api.github.com/repos/test/test/issues/1/comments',
        {
          method: 'POST',
          token: 'ghs_test',
          body: JSON.stringify({ body: 'LGTM' }),
        },
      );

      expect(response.ok).toBe(true);
      const data = (await response.json()) as { html_url: string };
      expect(data.html_url).toBe('https://github.com/test/test/pull/1#comment-1');
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('fetchReviewConfig returns 404 without retry', async () => {
      fetchMock.mockResolvedValueOnce(new Response('Not Found', { status: 404 }));

      const response = await fetchWithTimers(
        'https://api.github.com/repos/test/test/contents/.review.toml?ref=main',
        {
          token: 'ghs_test',
          accept: 'application/vnd.github.raw+json',
        },
      );

      expect(response.status).toBe(404);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });
  });
});
