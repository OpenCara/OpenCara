import { describe, it, expect } from 'vitest';
import worker from '../index.js';
import type { Env } from '../env.js';

const mockEnv: Env = {
  GITHUB_WEBHOOK_SECRET: 'test',
  GITHUB_APP_ID: 'test',
  GITHUB_APP_PRIVATE_KEY: '',
  GITHUB_CLIENT_ID: 'test',
  GITHUB_CLIENT_SECRET: '',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-key',
};

describe('worker', () => {
  it('returns 404 for unknown routes', async () => {
    const response = await worker.fetch(
      new Request('http://localhost/unknown'),
      mockEnv,
    );
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data).toEqual({ error: 'Not found' });
  });

  it('routes POST /webhook/github to webhook handler', async () => {
    const response = await worker.fetch(
      new Request('http://localhost/webhook/github', {
        method: 'POST',
        body: '{}',
      }),
      mockEnv,
    );
    // Without a valid signature, should get 401
    expect(response.status).toBe(401);
  });
});
