import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MemoryDataStore } from '../store/memory.js';
import { runScheduledEventPrunes } from '../store/cleanup.js';
import { RELIABILITY_WINDOW_MS, REPUTATION_PRUNE_AFTER_MS } from '../store/constants.js';
import { createLogger } from '../logger.js';

describe('runScheduledEventPrunes', () => {
  let store: MemoryDataStore;

  beforeEach(() => {
    store = new MemoryDataStore();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('calls reliability cleanup with a 2× window cutoff every tick', async () => {
    const spy = vi.spyOn(store, 'cleanupStaleReliabilityEvents');
    const offMinute = new Date('2026-04-01T00:05:00Z').getTime();
    await runScheduledEventPrunes(store, offMinute, createLogger());
    expect(spy).toHaveBeenCalledTimes(1);
    const [cutoff] = spy.mock.calls[0];
    expect(typeof cutoff).toBe('number');
    // Cutoff should be approximately now - 2*RELIABILITY_WINDOW_MS. Allow a 5s
    // slack because cleanup reads Date.now() internally.
    expect(Date.now() - (cutoff as number)).toBeGreaterThanOrEqual(
      2 * RELIABILITY_WINDOW_MS - 5_000,
    );
    expect(Date.now() - (cutoff as number)).toBeLessThanOrEqual(2 * RELIABILITY_WINDOW_MS + 5_000);
  });

  it('skips reputation cleanup off the hour (UTC minute !== 0)', async () => {
    const spy = vi.spyOn(store, 'cleanupStaleReputationEvents');
    const offMinute = new Date('2026-04-01T00:05:00Z').getTime();
    await runScheduledEventPrunes(store, offMinute, createLogger());
    expect(spy).not.toHaveBeenCalled();
  });

  it('runs reputation cleanup when UTC minute === 0', async () => {
    const spy = vi.spyOn(store, 'cleanupStaleReputationEvents');
    const onHour = new Date('2026-04-01T02:00:00Z').getTime();
    await runScheduledEventPrunes(store, onHour, createLogger());
    expect(spy).toHaveBeenCalledTimes(1);
    const [cutoff] = spy.mock.calls[0];
    expect(typeof cutoff).toBe('number');
    expect(Date.now() - (cutoff as number)).toBeGreaterThanOrEqual(
      REPUTATION_PRUNE_AFTER_MS - 5_000,
    );
  });

  it('uses UTC, not local-time, minute for the hourly gate', async () => {
    // A scheduledTime of 02:00 UTC is only ever minute 0 in UTC. If the code
    // used local getMinutes(), a non-zero UTC offset in minutes (e.g. India
    // Standard Time, +05:30) would shift the check to minute 30 and skip.
    // We simulate that by pinning Date.prototype.getMinutes to return 30 while
    // getUTCMinutes returns 0 for this instant.
    const spy = vi.spyOn(store, 'cleanupStaleReputationEvents');
    const localMinutes = vi.spyOn(Date.prototype, 'getMinutes').mockReturnValue(30);
    try {
      const onHour = new Date('2026-04-01T02:00:00Z').getTime();
      await runScheduledEventPrunes(store, onHour, createLogger());
      expect(spy).toHaveBeenCalledTimes(1);
    } finally {
      localMinutes.mockRestore();
    }
  });

  it('swallows reliability cleanup errors, logs at error level, and still runs reputation', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(store, 'cleanupStaleReliabilityEvents').mockRejectedValue(new Error('boom'));
    const reputationSpy = vi.spyOn(store, 'cleanupStaleReputationEvents').mockResolvedValue(0);
    const onHour = new Date('2026-04-01T02:00:00Z').getTime();
    await expect(runScheduledEventPrunes(store, onHour, createLogger())).resolves.toBeUndefined();
    const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toContain('cleanup_reliability');
    expect(reputationSpy).toHaveBeenCalledTimes(1);
  });

  it('swallows reputation cleanup errors and logs at error level', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(store, 'cleanupStaleReputationEvents').mockRejectedValue(new Error('boom'));
    const onHour = new Date('2026-04-01T02:00:00Z').getTime();
    await expect(runScheduledEventPrunes(store, onHour, createLogger())).resolves.toBeUndefined();
    const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toContain('cleanup_reputation');
  });

  it('emits info log only when reliability deleted > 0', async () => {
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(store, 'cleanupStaleReliabilityEvents').mockResolvedValue(0);
    await runScheduledEventPrunes(
      store,
      new Date('2026-04-01T00:05:00Z').getTime(),
      createLogger(),
    );
    let messages = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).not.toContain('cleanup_reliability');

    infoSpy.mockClear();
    vi.spyOn(store, 'cleanupStaleReliabilityEvents').mockResolvedValue(4);
    await runScheduledEventPrunes(
      store,
      new Date('2026-04-01T00:05:00Z').getTime(),
      createLogger(),
    );
    messages = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toContain('cleanup_reliability');
    expect(messages).toContain('"deleted":4');
  });

  it('emits info log only when reputation deleted > 0', async () => {
    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(store, 'cleanupStaleReputationEvents').mockResolvedValue(0);
    await runScheduledEventPrunes(
      store,
      new Date('2026-04-01T02:00:00Z').getTime(),
      createLogger(),
    );
    let messages = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).not.toContain('cleanup_reputation');

    infoSpy.mockClear();
    vi.spyOn(store, 'cleanupStaleReputationEvents').mockResolvedValue(7);
    await runScheduledEventPrunes(
      store,
      new Date('2026-04-01T02:00:00Z').getTime(),
      createLogger(),
    );
    messages = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
    expect(messages).toContain('cleanup_reputation');
    expect(messages).toContain('"deleted":7');
  });
});
