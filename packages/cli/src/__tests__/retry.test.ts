import { describe, it, expect, vi, afterEach } from 'vitest';
import { withRetry, NonRetryableError } from '../retry.js';

describe('withRetry', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns result on first success', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const result = await withRetry(fn);
    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('retries and succeeds on second attempt', async () => {
    const fn = vi.fn().mockRejectedValueOnce(new Error('fail')).mockResolvedValueOnce('ok');

    const result = await withRetry(fn, { baseDelayMs: 1, maxDelayMs: 1 });

    expect(result).toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('throws last error after maxAttempts exhausted', async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject(new Error('always fails')));

    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1, maxDelayMs: 1 })).rejects.toThrow(
      'always fails',
    );
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('respects maxAttempts: 1 (no retry)', async () => {
    const fn = vi.fn().mockImplementation(() => Promise.reject(new Error('fail')));
    await expect(withRetry(fn, { maxAttempts: 1 })).rejects.toThrow('fail');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('uses exponential backoff with jitter', async () => {
    const delays: number[] = [];
    // Intercept setTimeout to capture delays without actually waiting
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: TimerHandler, ms?: number) => {
      delays.push(ms ?? 0);
      // Call immediately to avoid real delays in test
      if (typeof cb === 'function') cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const fn = vi.fn().mockImplementation(() => Promise.reject(new Error('fail')));

    await expect(
      withRetry(fn, { maxAttempts: 4, baseDelayMs: 100, maxDelayMs: 10000 }),
    ).rejects.toThrow('fail');

    expect(fn).toHaveBeenCalledTimes(4);
    // 3 delays between 4 attempts: base 100, 200, 400 with ±30% jitter
    expect(delays).toHaveLength(3);
    expect(delays[0]).toBeGreaterThanOrEqual(70);
    expect(delays[0]).toBeLessThanOrEqual(130);
    expect(delays[1]).toBeGreaterThanOrEqual(140);
    expect(delays[1]).toBeLessThanOrEqual(260);
    expect(delays[2]).toBeGreaterThanOrEqual(280);
    expect(delays[2]).toBeLessThanOrEqual(520);
  });

  it('caps delay at maxDelayMs (with jitter)', async () => {
    const delays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: TimerHandler, ms?: number) => {
      delays.push(ms ?? 0);
      if (typeof cb === 'function') cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const fn = vi.fn().mockImplementation(() => Promise.reject(new Error('fail')));

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 20000, maxDelayMs: 30000 }),
    ).rejects.toThrow('fail');

    expect(fn).toHaveBeenCalledTimes(3);
    // Base delays: min(20000, 30000)=20000, min(40000, 30000)=30000 with ±30% jitter
    expect(delays).toHaveLength(2);
    expect(delays[0]).toBeGreaterThanOrEqual(14000);
    expect(delays[0]).toBeLessThanOrEqual(26000);
    expect(delays[1]).toBeGreaterThanOrEqual(21000);
    expect(delays[1]).toBeLessThanOrEqual(39000);
  });

  it('aborts immediately when signal is already aborted', async () => {
    const fn = vi.fn().mockResolvedValue('ok');
    const controller = new AbortController();
    controller.abort();

    await expect(withRetry(fn, {}, controller.signal)).rejects.toThrow('Aborted');
    expect(fn).not.toHaveBeenCalled();
  });

  it('stops retrying when signal is aborted between attempts', async () => {
    const controller = new AbortController();

    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: TimerHandler) => {
      // Abort during the sleep, then call the callback
      controller.abort();
      if (typeof cb === 'function') cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const fn = vi.fn().mockRejectedValueOnce(new Error('fail1')).mockResolvedValueOnce('ok');

    await expect(
      withRetry(fn, { maxAttempts: 3, baseDelayMs: 5000 }, controller.signal),
    ).rejects.toThrow('Aborted');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('does not delay after final failed attempt', async () => {
    const delays: number[] = [];
    vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: TimerHandler, ms?: number) => {
      delays.push(ms ?? 0);
      if (typeof cb === 'function') cb();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    });

    const fn = vi.fn().mockImplementation(() => Promise.reject(new Error('fail')));

    await expect(withRetry(fn, { maxAttempts: 2, baseDelayMs: 1000 })).rejects.toThrow('fail');

    expect(fn).toHaveBeenCalledTimes(2);
    // Only 1 delay (between attempt 0 and 1), base 1000 with ±30% jitter
    expect(delays).toHaveLength(1);
    expect(delays[0]).toBeGreaterThanOrEqual(700);
    expect(delays[0]).toBeLessThanOrEqual(1300);
  });

  it('does not retry NonRetryableError', async () => {
    const fn = vi.fn().mockRejectedValue(new NonRetryableError('404 Not Found'));

    await expect(withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 })).rejects.toThrow(
      '404 Not Found',
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('jitter produces non-deterministic delays', async () => {
    const runs: number[][] = [];

    for (let run = 0; run < 5; run++) {
      const delays: number[] = [];
      vi.spyOn(globalThis, 'setTimeout').mockImplementation((cb: TimerHandler, ms?: number) => {
        delays.push(ms ?? 0);
        if (typeof cb === 'function') cb();
        return 0 as unknown as ReturnType<typeof setTimeout>;
      });

      const fn = vi.fn().mockImplementation(() => Promise.reject(new Error('fail')));
      await expect(
        withRetry(fn, { maxAttempts: 3, baseDelayMs: 1000, maxDelayMs: 30000 }),
      ).rejects.toThrow('fail');
      runs.push(delays);
      vi.restoreAllMocks();
    }

    // At least two runs should have different first delays
    const firstDelays = runs.map((r) => r[0]);
    const unique = new Set(firstDelays);
    expect(unique.size).toBeGreaterThan(1);
  });

  it('preserves NonRetryableError type', async () => {
    const fn = vi.fn().mockRejectedValue(new NonRetryableError('forbidden'));

    try {
      await withRetry(fn, { maxAttempts: 3, baseDelayMs: 1 });
    } catch (err) {
      expect(err).toBeInstanceOf(NonRetryableError);
    }
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
