/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { handleGetConsumption } from '../handlers/consumption.js';
import type { User } from '@opencara/shared';

const mockUser: User = {
  id: 'user-123',
  github_id: 456,
  name: 'testuser',
  api_key_hash: 'hash',
  created_at: '2024-01-01',
};

describe('handleGetConsumption', () => {
  it('returns 410 Gone (consumption_logs table dropped)', async () => {
    const mockSupabase = {} as any;
    const response = await handleGetConsumption('agent-1', mockUser, mockSupabase);
    expect(response.status).toBe(410);
    const data = await response.json();
    expect(data.error).toContain('Consumption tracking has been removed');
  });
});
