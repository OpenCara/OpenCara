import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Key Revocation (POST /auth/revoke)', () => {
  let ctx: E2EContext;

  beforeEach(() => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(ctx.supabase.client as ReturnType<typeof createSupabaseClient>);
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  it('POST /auth/revoke returns 200 with a new API key', async () => {
    const { apiKey } = await ctx.createUser();

    const req = ctx.authedRequest('/auth/revoke', apiKey, { method: 'POST' });
    const res = await ctx.workerFetch(req);
    expect(res.status).toBe(200);

    const body = (await res.json()) as { apiKey: string };
    expect(body).toHaveProperty('apiKey');
    expect(body.apiKey).toMatch(/^cr_/);
  });

  it('old key is rejected after revocation', async () => {
    const { apiKey: oldKey } = await ctx.createUser();

    // Revoke the key
    const revokeReq = ctx.authedRequest('/auth/revoke', oldKey, { method: 'POST' });
    await ctx.workerFetch(revokeReq);

    // Old key should now be unauthorized
    const listReq = ctx.authedRequest('/api/agents', oldKey, { method: 'GET' });
    const res = await ctx.workerFetch(listReq);
    expect(res.status).toBe(401);
  });

  it('new key works after revocation', async () => {
    const { apiKey: oldKey } = await ctx.createUser();

    // Revoke and get new key
    const revokeReq = ctx.authedRequest('/auth/revoke', oldKey, { method: 'POST' });
    const revokeRes = await ctx.workerFetch(revokeReq);
    const { apiKey: newKey } = (await revokeRes.json()) as { apiKey: string };

    // New key should authenticate successfully
    const listReq = ctx.authedRequest('/api/agents', newKey, { method: 'GET' });
    const res = await ctx.workerFetch(listReq);
    expect(res.status).toBe(200);
  });

  it('new key has correct format: starts with "cr_" and is 43 chars total', async () => {
    const { apiKey } = await ctx.createUser();

    const req = ctx.authedRequest('/auth/revoke', apiKey, { method: 'POST' });
    const res = await ctx.workerFetch(req);
    const body = (await res.json()) as { apiKey: string };

    expect(body.apiKey.startsWith('cr_')).toBe(true);
    // "cr_" (3 chars) + 40 hex chars = 43 total
    expect(body.apiKey).toHaveLength(43);
  });
});
