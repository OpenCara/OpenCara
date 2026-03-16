import { describe, it, expect, vi } from 'vitest';

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => 'mock-supabase-client'),
}));

import { createSupabaseClient } from '../db.js';
import { createClient } from '@supabase/supabase-js';
import type { Env } from '../env.js';

const mockEnv: Env = {
  GITHUB_WEBHOOK_SECRET: 'secret',
  GITHUB_APP_ID: 'app-id',
  GITHUB_APP_PRIVATE_KEY: 'key',
  GITHUB_CLIENT_ID: 'client-id',
  GITHUB_CLIENT_SECRET: 'client-secret',
  SUPABASE_URL: 'https://test.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
};

describe('createSupabaseClient', () => {
  it('creates Supabase client with correct URL and key', () => {
    const client = createSupabaseClient(mockEnv);
    expect(createClient).toHaveBeenCalledWith('https://test.supabase.co', 'test-service-key');
    expect(client).toBe('mock-supabase-client');
  });
});
