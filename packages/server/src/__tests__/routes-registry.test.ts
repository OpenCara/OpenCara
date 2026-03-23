import { describe, it, expect } from 'vitest';
import { DEFAULT_REGISTRY } from '@opencara/shared';
import { MemoryDataStore } from '../store/memory.js';
import { createApp } from '../index.js';

const mockEnv = {
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: 'test-key',
  WEB_URL: 'https://test.com',
};

describe('Registry Route', () => {
  it('GET /api/registry returns the default registry', async () => {
    const app = createApp(new MemoryDataStore());
    const res = await app.request('/api/registry', { method: 'GET' }, mockEnv);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(DEFAULT_REGISTRY);
  });
});
