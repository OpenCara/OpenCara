import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

// Mock only the Supabase client factory — everything else runs for real
vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('Auth Device Flow (E2E)', () => {
  let ctx: E2EContext;

  beforeEach(() => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(ctx.supabase.client as never);
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  it('POST /auth/device returns device flow fields', async () => {
    const res = await ctx.workerFetch(
      new Request('https://api.opencara.dev/auth/device', { method: 'POST' }),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty('userCode');
    expect(body).toHaveProperty('verificationUri');
    expect(body).toHaveProperty('deviceCode');
    expect(body).toHaveProperty('expiresIn');
    expect(body).toHaveProperty('interval');
  });

  it('POST /auth/device/token with pending status returns pending', async () => {
    // Default mock state is authorization_pending
    ctx.github.options.deviceTokenStatus = undefined; // defaults to pending

    const res = await ctx.workerFetch(
      new Request('https://api.opencara.dev/auth/device/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'test-device-code' }),
      }),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ status: 'pending' });
  });

  it('POST /auth/device/token with expired status returns expired', async () => {
    ctx.github.options.deviceTokenStatus = 'expired';

    const res = await ctx.workerFetch(
      new Request('https://api.opencara.dev/auth/device/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'test-device-code' }),
      }),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toEqual({ status: 'expired' });
  });

  it('POST /auth/device/token after complete returns apiKey', async () => {
    ctx.github.options.deviceTokenStatus = 'complete';
    ctx.github.options.githubUser = { id: 99, login: 'newuser', avatar_url: 'https://example.com/avatar.png' };

    const res = await ctx.workerFetch(
      new Request('https://api.opencara.dev/auth/device/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: 'test-device-code' }),
      }),
    );
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.status).toBe('complete');
    expect(body.apiKey).toBeDefined();
    expect(body.apiKey).toMatch(/^cr_/);
  });

  it('full cycle: device flow → token → use API key for GET /api/agents', async () => {
    // Step 1: Initiate device flow
    const deviceRes = await ctx.workerFetch(
      new Request('https://api.opencara.dev/auth/device', { method: 'POST' }),
    );
    expect(deviceRes.status).toBe(200);
    const deviceData = await deviceRes.json();
    expect(deviceData.deviceCode).toBeDefined();

    // Step 2: Complete token exchange
    ctx.github.options.deviceTokenStatus = 'complete';
    ctx.github.options.githubUser = { id: 42, login: 'cycleuser', avatar_url: 'https://example.com/a.png' };

    const tokenRes = await ctx.workerFetch(
      new Request('https://api.opencara.dev/auth/device/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ deviceCode: deviceData.deviceCode }),
      }),
    );
    expect(tokenRes.status).toBe(200);
    const tokenData = await tokenRes.json();
    expect(tokenData.status).toBe('complete');
    expect(tokenData.apiKey).toMatch(/^cr_/);

    // Step 3: Use the API key for authenticated request
    const agentsRes = await ctx.workerFetch(
      ctx.authedRequest('/api/agents', tokenData.apiKey),
    );
    expect(agentsRes.status).toBe(200);
  });

  it('missing deviceCode returns 400', async () => {
    const res = await ctx.workerFetch(
      new Request('https://api.opencara.dev/auth/device/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it('invalid JSON body returns 400', async () => {
    const res = await ctx.workerFetch(
      new Request('https://api.opencara.dev/auth/device/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: 'not json at all',
      }),
    );
    expect(res.status).toBe(400);
  });
});
