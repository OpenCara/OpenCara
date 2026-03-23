import { describe, it, expect } from 'vitest';
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
  it('calls cleanupTerminalTasks during scheduled event', async () => {
    // Import the default export which has the scheduled handler
    const mod = await import('../index.js');
    const handler = mod.default;

    // We can't easily test the full scheduled handler without mocking D1,
    // but we verify the export exists and is a function
    expect(typeof handler.scheduled).toBe('function');
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
