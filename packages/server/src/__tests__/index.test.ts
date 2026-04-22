import { describe, it, expect, vi } from 'vitest';
import { parseTtlDays, createStore } from '../index.js';
import { D1DataStore } from '../store/d1.js';
import { MemoryDataStore } from '../store/memory.js';
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
  it('exposes a scheduled function', async () => {
    const mod = await import('../index.js');
    expect(typeof mod.default.scheduled).toBe('function');
  });

  it('delegates event-table pruning to runScheduledEventPrunes', async () => {
    // Spy on the Memory store methods invoked by the shared helper so we can
    // confirm the scheduled handler wires them in without re-asserting the
    // helper's own logic (which cleanup-scheduled.test.ts covers).
    const mod = await import('../index.js');
    const reliabilitySpy = vi
      .spyOn(MemoryDataStore.prototype, 'cleanupStaleReliabilityEvents')
      .mockResolvedValue(0);
    const reputationSpy = vi
      .spyOn(MemoryDataStore.prototype, 'cleanupStaleReputationEvents')
      .mockResolvedValue(0);
    try {
      // minute === 0 UTC → both prunes should fire.
      await mod.default.scheduled(
        { scheduledTime: new Date('2026-04-01T02:00:00Z').getTime(), cron: '* * * * *' },
        makeEnv(),
      );
      expect(reliabilitySpy).toHaveBeenCalledTimes(1);
      expect(reputationSpy).toHaveBeenCalledTimes(1);
    } finally {
      reliabilitySpy.mockRestore();
      reputationSpy.mockRestore();
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
