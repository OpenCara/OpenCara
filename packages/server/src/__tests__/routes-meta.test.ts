import { describe, it, expect } from 'vitest';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';
import { SERVER_VERSION, MIN_CLI_VERSION } from '../version.js';

const mockEnv = {
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: 'test-key',
  WEB_URL: 'https://test.com',
};

describe('Meta Route', () => {
  it('GET /api/meta returns correct shape', async () => {
    const app = createApp(new MemoryDataStore());
    const res = await app.request('/api/meta', { method: 'GET' }, mockEnv);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      server_version: SERVER_VERSION,
      min_cli_version: MIN_CLI_VERSION,
      features: [],
    });
  });

  it('GET /api/meta does not require auth', async () => {
    const app = createApp(new MemoryDataStore());
    const res = await app.request(
      '/api/meta',
      { method: 'GET' },
      { ...mockEnv, GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret' },
    );
    expect(res.status).toBe(200);
  });
});
