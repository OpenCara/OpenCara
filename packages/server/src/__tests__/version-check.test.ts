import { describe, it, expect } from 'vitest';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import { parseSemver } from '../middleware/version-check.js';
import { MIN_CLI_VERSION } from '../version.js';

const mockEnv = {
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: 'test-key',
  WEB_URL: 'https://test.com',
};

describe('parseSemver', () => {
  it('parses valid semver strings', () => {
    expect(parseSemver('1.2.3')).toEqual([1, 2, 3]);
    expect(parseSemver('0.15.0')).toEqual([0, 15, 0]);
    expect(parseSemver('10.20.30')).toEqual([10, 20, 30]);
  });

  it('returns null for invalid strings', () => {
    expect(parseSemver('1.2')).toBeNull();
    expect(parseSemver('abc')).toBeNull();
    expect(parseSemver('1.2.3-beta')).toBeNull();
    expect(parseSemver('')).toBeNull();
    expect(parseSemver('v1.2.3')).toBeNull();
  });
});

describe('Version Check Middleware', () => {
  it('rejects requests with outdated CLI version', async () => {
    const app = createApp(new MemoryDataStore());
    const res = await app.request(
      '/api/tasks/poll',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OpenCara-CLI-Version': '0.14.0',
        },
        body: JSON.stringify({ agent_id: 'test' }),
      },
      mockEnv,
    );
    expect(res.status).toBe(426);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('CLI_OUTDATED');
    expect(body.error.message).toContain('0.14.0');
    expect(body.error.message).toContain(MIN_CLI_VERSION);
  });

  it('allows requests with current CLI version', async () => {
    const app = createApp(new MemoryDataStore());
    const res = await app.request(
      '/api/tasks/poll',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OpenCara-CLI-Version': MIN_CLI_VERSION,
        },
        body: JSON.stringify({ agent_id: 'test' }),
      },
      mockEnv,
    );
    // Should pass the version check (may fail later due to missing body fields, but not 426)
    expect(res.status).not.toBe(426);
  });

  it('allows requests with newer CLI version', async () => {
    const app = createApp(new MemoryDataStore());
    const res = await app.request(
      '/api/tasks/poll',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OpenCara-CLI-Version': '99.0.0',
        },
        body: JSON.stringify({ agent_id: 'test' }),
      },
      mockEnv,
    );
    expect(res.status).not.toBe(426);
  });

  it('allows requests with missing CLI version header (backward compat)', async () => {
    const app = createApp(new MemoryDataStore());
    const res = await app.request(
      '/api/tasks/poll',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_id: 'test' }),
      },
      mockEnv,
    );
    expect(res.status).not.toBe(426);
  });

  it('allows requests with malformed CLI version header', async () => {
    const app = createApp(new MemoryDataStore());
    const res = await app.request(
      '/api/tasks/poll',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-OpenCara-CLI-Version': 'not-a-version',
        },
        body: JSON.stringify({ agent_id: 'test' }),
      },
      mockEnv,
    );
    expect(res.status).not.toBe(426);
  });

  it('does not apply to non-task endpoints', async () => {
    const app = createApp(new MemoryDataStore());
    const res = await app.request(
      '/api/registry',
      {
        method: 'GET',
        headers: { 'X-OpenCara-CLI-Version': '0.0.1' },
      },
      mockEnv,
    );
    expect(res.status).toBe(200);
  });

  it('does not apply to /api/meta endpoint', async () => {
    const app = createApp(new MemoryDataStore());
    const res = await app.request(
      '/api/meta',
      {
        method: 'GET',
        headers: { 'X-OpenCara-CLI-Version': '0.0.1' },
      },
      mockEnv,
    );
    expect(res.status).toBe(200);
  });
});
