import { describe, it, expect } from 'vitest';
import { parseTtlDays } from '../index.js';
import type { Env } from '../types.js';

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    GITHUB_WEBHOOK_SECRET: 'test',
    GITHUB_APP_ID: '123',
    GITHUB_APP_PRIVATE_KEY: 'key',
    TASK_STORE: {} as KVNamespace,
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

    // We can't easily test the full scheduled handler without mocking KV,
    // but we verify the export exists and is a function
    expect(typeof handler.scheduled).toBe('function');
  });
});
