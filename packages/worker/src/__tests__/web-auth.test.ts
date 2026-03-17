/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleWebLogin, handleWebCallback, handleWebLogout } from '../handlers/web-auth.js';
import type { Env } from '../env.js';

const mockEnv: Env = {
  GITHUB_CLIENT_ID: 'test-client-id',
  GITHUB_CLIENT_SECRET: 'test-secret',
  GITHUB_WEBHOOK_SECRET: '',
  GITHUB_APP_ID: '',
  GITHUB_APP_PRIVATE_KEY: '',
  SUPABASE_URL: '',
  SUPABASE_SERVICE_ROLE_KEY: '',
  WEB_URL: 'https://opencara.dev',
  WORKER_URL: 'https://api.opencara.dev',
} as any;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('handleWebLogin', () => {
  it('redirects to GitHub OAuth with correct params', async () => {
    const request = new Request('https://api.opencara.dev/auth/login');
    const response = await handleWebLogin(request, mockEnv);

    expect(response.status).toBe(302);
    const location = response.headers.get('Location')!;
    const url = new URL(location);

    expect(url.origin).toBe('https://github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe('https://api.opencara.dev/auth/callback');
    expect(url.searchParams.get('scope')).toBe('read:user');
    expect(url.searchParams.get('state')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('sets state cookie with correct flags', async () => {
    const request = new Request('https://api.opencara.dev/auth/login');
    const response = await handleWebLogin(request, mockEnv);

    const setCookie = response.headers.get('Set-Cookie')!;
    expect(setCookie).toContain('opencara_oauth_state=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=300');
  });

  it('sets state cookie without Secure on http', async () => {
    const request = new Request('http://localhost/auth/login');
    const response = await handleWebLogin(request, mockEnv);

    const setCookie = response.headers.get('Set-Cookie')!;
    expect(setCookie).not.toContain('Secure');
  });

  it('state in cookie matches state in redirect URL', async () => {
    const request = new Request('https://api.opencara.dev/auth/login');
    const response = await handleWebLogin(request, mockEnv);

    const location = new URL(response.headers.get('Location')!);
    const urlState = location.searchParams.get('state');

    const setCookie = response.headers.get('Set-Cookie')!;
    const cookieState = setCookie.split('=')[1].split(';')[0];

    expect(urlState).toBe(cookieState);
  });
});

describe('handleWebCallback', () => {
  function createMockSupabase(upsertError: any = null) {
    return {
      from: vi.fn().mockReturnValue({
        upsert: vi.fn().mockResolvedValue({ error: upsertError }),
      }),
    } as any;
  }

  const validState = 'abcdef1234567890abcdef1234567890';

  function makeCallbackRequest(params: {
    code?: string;
    state?: string;
    cookie?: string;
  }): Request {
    const url = new URL('https://api.opencara.dev/auth/callback');
    if (params.code) url.searchParams.set('code', params.code);
    if (params.state) url.searchParams.set('state', params.state);

    const headers: Record<string, string> = {};
    if (params.cookie) {
      headers['Cookie'] = params.cookie;
    }

    return new Request(url.toString(), { headers });
  }

  it('returns 400 when code is missing', async () => {
    const request = makeCallbackRequest({ state: validState });
    const response = await handleWebCallback(request, mockEnv, createMockSupabase());
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toContain('Missing code or state');
  });

  it('returns 400 when state is missing', async () => {
    const request = makeCallbackRequest({ code: 'test-code' });
    const response = await handleWebCallback(request, mockEnv, createMockSupabase());
    expect(response.status).toBe(400);
  });

  it('returns 403 when state does not match cookie (CSRF)', async () => {
    const request = makeCallbackRequest({
      code: 'test-code',
      state: validState,
      cookie: `opencara_oauth_state=different_state`,
    });
    const response = await handleWebCallback(request, mockEnv, createMockSupabase());
    expect(response.status).toBe(403);
    const data = await response.json();
    expect(data.error).toContain('CSRF');
  });

  it('returns 403 when no state cookie present', async () => {
    const request = makeCallbackRequest({
      code: 'test-code',
      state: validState,
    });
    const response = await handleWebCallback(request, mockEnv, createMockSupabase());
    expect(response.status).toBe(403);
  });

  it('returns 502 when token exchange fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(new Response('Error', { status: 500 }));

    const request = makeCallbackRequest({
      code: 'test-code',
      state: validState,
      cookie: `opencara_oauth_state=${validState}`,
    });
    const response = await handleWebCallback(request, mockEnv, createMockSupabase());
    expect(response.status).toBe(502);
  });

  it('returns 502 when GitHub returns OAuth error', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: 'bad_verification_code' }), { status: 200 }),
      );

    const request = makeCallbackRequest({
      code: 'test-code',
      state: validState,
      cookie: `opencara_oauth_state=${validState}`,
    });
    const response = await handleWebCallback(request, mockEnv, createMockSupabase());
    expect(response.status).toBe(502);
    const data = await response.json();
    expect(data.error).toBe('GitHub OAuth error');
  });

  it('returns 502 when user profile fetch fails', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'ghu_abc123' }), { status: 200 }),
      )
      .mockResolvedValueOnce(new Response('Unauthorized', { status: 401 }));

    const request = makeCallbackRequest({
      code: 'test-code',
      state: validState,
      cookie: `opencara_oauth_state=${validState}`,
    });
    const response = await handleWebCallback(request, mockEnv, createMockSupabase());
    expect(response.status).toBe(502);
  });

  it('returns 500 when Supabase upsert fails', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'ghu_abc123' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 12345,
            login: 'testuser',
            avatar_url: 'https://example.com/avatar',
          }),
          { status: 200 },
        ),
      );

    const request = makeCallbackRequest({
      code: 'test-code',
      state: validState,
      cookie: `opencara_oauth_state=${validState}`,
    });
    const response = await handleWebCallback(
      request,
      mockEnv,
      createMockSupabase({ message: 'DB error' }),
    );
    expect(response.status).toBe(500);
  });

  it('redirects to dashboard with session cookie on success', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'ghu_abc123' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 12345,
            login: 'testuser',
            avatar_url: 'https://example.com/avatar',
          }),
          { status: 200 },
        ),
      );

    const request = makeCallbackRequest({
      code: 'test-code',
      state: validState,
      cookie: `opencara_oauth_state=${validState}`,
    });
    const response = await handleWebCallback(request, mockEnv, createMockSupabase());

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://opencara.dev/dashboard');

    // Check cookies - response has multiple Set-Cookie headers
    const cookies = response.headers.getSetCookie();
    expect(cookies.length).toBe(2);

    // Session cookie
    const sessionCookie = cookies.find((c) => c.startsWith('opencara_session='))!;
    expect(sessionCookie).toContain('cr_');
    expect(sessionCookie).toContain('HttpOnly');
    expect(sessionCookie).toContain('Secure');
    expect(sessionCookie).toContain('SameSite=Lax');
    expect(sessionCookie).toContain('Max-Age=2592000');

    // State cookie cleared
    const stateCookie = cookies.find((c) => c.startsWith('opencara_oauth_state='))!;
    expect(stateCookie).toContain('Max-Age=0');
  });

  it('sends correct params to GitHub token exchange', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'ghu_abc123' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 12345,
            login: 'testuser',
            avatar_url: 'https://example.com/avatar',
          }),
          { status: 200 },
        ),
      );
    globalThis.fetch = mockFetch;

    const request = makeCallbackRequest({
      code: 'my-auth-code',
      state: validState,
      cookie: `opencara_oauth_state=${validState}`,
    });
    await handleWebCallback(request, mockEnv, createMockSupabase());

    expect(mockFetch).toHaveBeenCalledWith(
      'https://github.com/login/oauth/access_token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          client_id: 'test-client-id',
          client_secret: 'test-secret',
          code: 'my-auth-code',
        }),
      }),
    );
  });

  it('upserts user with correct data', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'ghu_abc123' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ id: 99, login: 'octocat', avatar_url: 'https://avatars.com/99' }),
          { status: 200 },
        ),
      );

    const mockUpsert = vi.fn().mockResolvedValue({ error: null });
    const mockSupabase = {
      from: vi.fn().mockReturnValue({
        upsert: mockUpsert,
      }),
    } as any;

    const request = makeCallbackRequest({
      code: 'test-code',
      state: validState,
      cookie: `opencara_oauth_state=${validState}`,
    });
    await handleWebCallback(request, mockEnv, mockSupabase);

    expect(mockSupabase.from).toHaveBeenCalledWith('users');
    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        github_id: 99,
        name: 'octocat',
        avatar: 'https://avatars.com/99',
        api_key_hash: expect.any(String),
        updated_at: expect.any(String),
      }),
      { onConflict: 'github_id' },
    );
  });

  it('uses default WEB_URL when not set', async () => {
    const envWithoutWebUrl = { ...mockEnv, WEB_URL: '' } as any;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ access_token: 'ghu_abc123' }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: 12345,
            login: 'testuser',
            avatar_url: 'https://example.com/avatar',
          }),
          { status: 200 },
        ),
      );

    const request = makeCallbackRequest({
      code: 'test-code',
      state: validState,
      cookie: `opencara_oauth_state=${validState}`,
    });
    const response = await handleWebCallback(request, envWithoutWebUrl, createMockSupabase());
    expect(response.headers.get('Location')).toBe('http://localhost:3000/dashboard');
  });
});

describe('handleWebLogout', () => {
  it('redirects to web homepage', async () => {
    const request = new Request('https://api.opencara.dev/auth/logout');
    const response = await handleWebLogout(request, mockEnv);

    expect(response.status).toBe(302);
    expect(response.headers.get('Location')).toBe('https://opencara.dev');
  });

  it('clears the session cookie', async () => {
    const request = new Request('https://api.opencara.dev/auth/logout');
    const response = await handleWebLogout(request, mockEnv);

    const setCookie = response.headers.get('Set-Cookie')!;
    expect(setCookie).toContain('opencara_session=');
    expect(setCookie).toContain('Max-Age=0');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
  });

  it('uses default WEB_URL when not set', async () => {
    const envWithoutWebUrl = { ...mockEnv, WEB_URL: '' } as any;
    const request = new Request('http://localhost/auth/logout');
    const response = await handleWebLogout(request, envWithoutWebUrl);

    expect(response.headers.get('Location')).toBe('http://localhost:3000');
  });
});
