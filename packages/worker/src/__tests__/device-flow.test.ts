import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  handleDeviceFlow,
  handleDeviceToken,
  handleRevokeKey,
} from '../handlers/device-flow.js';
import type { Env } from '../env.js';

const mockEnv: Env = {
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-secret',
  GITHUB_WEBHOOK_SECRET: '',
  GITHUB_APP_ID: '',
  GITHUB_APP_PRIVATE_KEY: '',
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('handleDeviceFlow', () => {
  it('returns device code on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_code: 'abc123',
          user_code: 'ABCD-1234',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }),
        { status: 200 },
      ),
    );

    const response = await handleDeviceFlow(mockEnv);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.userCode).toBe('ABCD-1234');
    expect(data.verificationUri).toBe('https://github.com/login/device');
    expect(data.expiresIn).toBe(900);
    expect(data.interval).toBe(5);
    expect(data.deviceCode).toBe('abc123');
  });

  it('sends correct client_id to GitHub', async () => {
    const mockFetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          device_code: 'x',
          user_code: 'X',
          verification_uri: 'https://github.com/login/device',
          expires_in: 900,
          interval: 5,
        }),
        { status: 200 },
      ),
    );
    globalThis.fetch = mockFetch;

    await handleDeviceFlow(mockEnv);

    expect(mockFetch).toHaveBeenCalledWith(
      'https://github.com/login/device/code',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          client_id: 'test-client-id',
          scope: 'read:user',
        }),
      }),
    );
  });

  it('returns 502 when GitHub API fails', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response('Error', { status: 500 }));

    const response = await handleDeviceFlow(mockEnv);
    expect(response.status).toBe(502);
  });
});

describe('handleDeviceToken', () => {
  function createMockSupabase() {
    return {
      from: vi.fn().mockReturnValue({
        upsert: vi.fn().mockResolvedValue({ error: null }),
      }),
    } as any;
  }

  it('returns pending when authorization is pending', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'authorization_pending' }), {
        status: 200,
      }),
    );

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ deviceCode: 'abc123' }),
    });

    const response = await handleDeviceToken(
      request,
      mockEnv,
      createMockSupabase(),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe('pending');
  });

  it('returns expired when token is expired', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'expired_token' }), {
        status: 200,
      }),
    );

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ deviceCode: 'abc123' }),
    });

    const response = await handleDeviceToken(
      request,
      mockEnv,
      createMockSupabase(),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe('expired');
  });

  it('returns complete with API key on success', async () => {
    globalThis.fetch = vi
      .fn()
      // First call: token exchange
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'ghu_abc123' }), {
          status: 200,
        }),
      )
      // Second call: user profile
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 12345,
            login: 'testuser',
            avatar_url: 'https://avatars.githubusercontent.com/u/12345',
          }),
          { status: 200 },
        ),
      );

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ deviceCode: 'abc123' }),
    });

    const response = await handleDeviceToken(
      request,
      mockEnv,
      createMockSupabase(),
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.status).toBe('complete');
    expect(data.apiKey).toMatch(/^cr_[0-9a-f]{40}$/);
  });

  it('returns 400 when deviceCode is missing', async () => {
    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({}),
    });

    const response = await handleDeviceToken(
      request,
      mockEnv,
      createMockSupabase(),
    );
    expect(response.status).toBe(400);
  });

  it('returns 502 when user profile fetch fails', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'ghu_abc' }), {
          status: 200,
        }),
      )
      .mockResolvedValueOnce(new Response('Error', { status: 401 }));

    const request = new Request('http://localhost', {
      method: 'POST',
      body: JSON.stringify({ deviceCode: 'abc123' }),
    });

    const response = await handleDeviceToken(
      request,
      mockEnv,
      createMockSupabase(),
    );
    expect(response.status).toBe(502);
  });
});

describe('handleRevokeKey', () => {
  it('generates new API key and updates user', async () => {
    const mockUser = {
      id: '123',
      github_id: 456,
      name: 'testuser',
      avatar: null,
      api_key_hash: 'oldhash',
      reputation_score: 0,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    };
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnValue({
          eq: vi.fn().mockResolvedValue({ error: null }),
        }),
      }),
    } as any;

    const response = await handleRevokeKey(mockUser, mockSupabase);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.apiKey).toMatch(/^cr_[0-9a-f]{40}$/);
  });

  it('returns 500 when database update fails', async () => {
    const mockUser = {
      id: '123',
      github_id: 456,
      name: 'testuser',
      avatar: null,
      api_key_hash: 'oldhash',
      reputation_score: 0,
      created_at: '2024-01-01',
      updated_at: '2024-01-01',
    };
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        update: vi.fn().mockReturnValue({
          eq: vi
            .fn()
            .mockResolvedValue({ error: { message: 'DB error' } }),
        }),
      }),
    } as any;

    const response = await handleRevokeKey(mockUser, mockSupabase);
    expect(response.status).toBe(500);
  });
});
