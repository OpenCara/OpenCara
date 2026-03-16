import { describe, it, expect } from 'vitest';
import worker from '../index.js';
import type { Env } from '../env.js';

const mockEnv: Env = {
  GITHUB_WEBHOOK_SECRET: '',
  GITHUB_APP_ID: '',
  GITHUB_APP_PRIVATE_KEY: '',
  GITHUB_CLIENT_ID: '',
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
});
