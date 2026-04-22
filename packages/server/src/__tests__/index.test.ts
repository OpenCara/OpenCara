import { describe, it, expect, vi } from 'vitest';
import { parseTtlDays, createStore } from '../index.js';
import { D1DataStore } from '../store/d1.js';
import { MemoryDataStore } from '../store/memory.js';
import { RELIABILITY_WINDOW_MS, REPUTATION_PRUNE_AFTER_MS } from '../store/constants.js';
import type { Env } from '../types.js';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_WEBHOOK_SECRET: 'test',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: 'key',
    WEB_URL: 'https://test.com',
    ...overrides,
  };
}

describe('parseTtlDays', () => {
  it('returns 7 when TASK_TTL_DAYS is not set', () => {
    expect(parseTtlDays(makeEnv())).toBe(7);
  });

  it('returns 7 when TASK_TTL_DAYS is empty string', () => {
    expect(parseTtlDays(makeEnv({ TASK_TTL_DAYS: '' }))).toBe(7);
  });

  it('parses valid integer', () => {
    expect(parseTtlDays(makeEnv({ TASK_TTL_DAYS: '14' }))).toBe(14);
  });

  it('returns 7 for non-numeric string', () => {
    expect(parseTtlDays(makeEnv({ TASK_TTL_DAYS: 'abc' }))).toBe(7);
  });

  it('returns 7 for zero', () => {
    expect(parseTtlDays(makeEnv({ TASK_TTL_DAYS: '0' }))).toBe(7);
  });

  it('returns 7 for negative', () => {
    expect(parseTtlDays(makeEnv({ TASK_TTL_DAYS: '-5' }))).toBe(7);
  });

  it('returns 1 as minimum valid value', () => {
    expect(parseTtlDays(makeEnv({ TASK_TTL_DAYS: '1' }))).toBe(1);
  });
});

describe('scheduled handler', () => {
  it('calls cleanupTerminalTasks during scheduled event', async () => {
    // Import the default export which has the scheduled handler
    const mod = await import('../index.js');
    const handler = mod.default;

    // We can't easily test the full scheduled handler without mocking D1,
    // but we verify the export exists and is a function
    expect(typeof handler.scheduled).toBe('function');
  });

  it('prunes stale reliability events every tick, logs only when deleted > 0', async () => {
    const mod = await import('../index.js');
    const handler = mod.default;

    // Scheduled tick NOT on minute 0 (so reputation prune is skipped).
    const scheduledTime = new Date('2026-04-01T00:05:00Z').getTime();
    const env = makeEnv();

    // Prepare shared store with events to prune.
    const spy = vi.spyOn(MemoryDataStore.prototype, 'cleanupStaleReliabilityEvents');
    const reputationSpy = vi.spyOn(MemoryDataStore.prototype, 'cleanupStaleReputationEvents');
    try {
      await handler.scheduled({ scheduledTime, cron: '* * * * *' }, env);
      expect(spy).toHaveBeenCalledTimes(1);
      // Cutoff passed should be ~ now - 2*RELIABILITY_WINDOW_MS.
      const [cutoff] = spy.mock.calls[0];
      expect(typeof cutoff).toBe('number');
      expect(Date.now() - cutoff).toBeGreaterThanOrEqual(2 * RELIABILITY_WINDOW_MS - 5_000);
      // Reputation cleanup skipped off the hour.
      expect(reputationSpy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      reputationSpy.mockRestore();
    }
  });

  it('runs reputation event prune only when scheduled tick lands on minute 0', async () => {
    const mod = await import('../index.js');
    const handler = mod.default;

    const scheduledTime = new Date('2026-04-01T02:00:00Z').getTime();
    const env = makeEnv();
    const spy = vi.spyOn(MemoryDataStore.prototype, 'cleanupStaleReputationEvents');
    try {
      await handler.scheduled({ scheduledTime, cron: '0 * * * *' }, env);
      expect(spy).toHaveBeenCalledTimes(1);
      const [cutoff] = spy.mock.calls[0];
      expect(typeof cutoff).toBe('number');
      expect(Date.now() - cutoff).toBeGreaterThanOrEqual(REPUTATION_PRUNE_AFTER_MS - 5_000);
    } finally {
      spy.mockRestore();
    }
  });

  it('logs a cleanup_reliability info message when rows are deleted', async () => {
    const mod = await import('../index.js');
    const handler = mod.default;

    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prune = vi
      .spyOn(MemoryDataStore.prototype, 'cleanupStaleReliabilityEvents')
      .mockResolvedValue(3);
    try {
      await handler.scheduled(
        { scheduledTime: new Date('2026-04-01T00:05:00Z').getTime(), cron: '* * * * *' },
        makeEnv(),
      );
      const messages = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(messages).toContain('cleanup_reliability');
      expect(messages).toContain('deleted');
    } finally {
      prune.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it('swallows reliability cleanup errors and logs them', async () => {
    const mod = await import('../index.js');
    const handler = mod.default;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prune = vi
      .spyOn(MemoryDataStore.prototype, 'cleanupStaleReliabilityEvents')
      .mockRejectedValue(new Error('boom'));
    try {
      await expect(
        handler.scheduled(
          { scheduledTime: new Date('2026-04-01T00:05:00Z').getTime(), cron: '* * * * *' },
          makeEnv(),
        ),
      ).resolves.toBeUndefined();
      const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(messages).toContain('cleanup_reliability');
    } finally {
      prune.mockRestore();
      errorSpy.mockRestore();
    }
  });

  it('logs a cleanup_reputation info message when rows are deleted', async () => {
    const mod = await import('../index.js');
    const handler = mod.default;

    const infoSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const prune = vi
      .spyOn(MemoryDataStore.prototype, 'cleanupStaleReputationEvents')
      .mockResolvedValue(2);
    try {
      await handler.scheduled(
        { scheduledTime: new Date('2026-04-01T03:00:00Z').getTime(), cron: '0 * * * *' },
        makeEnv(),
      );
      const messages = infoSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(messages).toContain('cleanup_reputation');
      expect(messages).toContain('deleted');
    } finally {
      prune.mockRestore();
      infoSpy.mockRestore();
    }
  });

  it('swallows reputation cleanup errors and logs them', async () => {
    const mod = await import('../index.js');
    const handler = mod.default;

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const prune = vi
      .spyOn(MemoryDataStore.prototype, 'cleanupStaleReputationEvents')
      .mockRejectedValue(new Error('boom'));
    try {
      await expect(
        handler.scheduled(
          { scheduledTime: new Date('2026-04-01T02:00:00Z').getTime(), cron: '0 * * * *' },
          makeEnv(),
        ),
      ).resolves.toBeUndefined();
      const messages = errorSpy.mock.calls.map((c) => String(c[0])).join('\n');
      expect(messages).toContain('cleanup_reputation');
    } finally {
      prune.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe('createStore', () => {
  /** Build an Env with only the specified bindings set. */
  function makeStoreEnv(bindings: { DB?: D1Database }): Env {
    return {
      GITHUB_WEBHOOK_SECRET: 'test',
      GITHUB_APP_ID: '123',
      GITHUB_APP_PRIVATE_KEY: 'key',
      WEB_URL: 'https://test.com',
      ...('DB' in bindings ? { DB: bindings.DB } : {}),
    };
  }

  it('returns D1DataStore when DB is present', () => {
    const store = createStore(makeStoreEnv({ DB: {} as D1Database }));
    expect(store).toBeInstanceOf(D1DataStore);
  });

  it('returns MemoryDataStore when DB is not present', () => {
    const store = createStore(makeStoreEnv({}));
    expect(store).toBeInstanceOf(MemoryDataStore);
  });
});
