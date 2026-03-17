import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Web OAuth Flow', () => {
  let ctx: E2EContext;

  beforeEach(() => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(ctx.supabase.client as ReturnType<typeof createSupabaseClient>);
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  it('GET /auth/login redirects to GitHub with correct params', async () => {
    const req = new Request('https://api.opencara.dev/auth/login');
    const res = await ctx.workerFetch(req);

    expect(res.status).toBe(302);

    const location = res.headers.get('Location');
    expect(location).toBeDefined();

    const url = new URL(location!);
    expect(url.hostname).toBe('github.com');
    expect(url.pathname).toBe('/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://api.opencara.dev/auth/callback',
    );
    expect(url.searchParams.get('scope')).toBe('read:user');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('state cookie set with HttpOnly', async () => {
    const req = new Request('https://api.opencara.dev/auth/login');
    const res = await ctx.workerFetch(req);

    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('opencara_oauth_state=');
    expect(setCookie).toContain('HttpOnly');
  });

  it('GET /auth/callback with valid code and state redirects to dashboard', async () => {
    // Set up GitHub mock to return an access token and user profile
    ctx.github.options.accessToken = 'gho_valid_test_token';
    ctx.github.options.githubUser = {
      id: 88888,
      login: 'web-oauth-user',
      avatar_url: 'https://example.com/avatar.png',
    };

    // First, do the login to get the state value
    const loginReq = new Request('https://api.opencara.dev/auth/login');
    const loginRes = await ctx.workerFetch(loginReq);
    const location = loginRes.headers.get('Location')!;
    const state = new URL(location).searchParams.get('state')!;

    // Extract the state cookie from login response
    const stateCookie = loginRes.headers.get('Set-Cookie')!;
    // Parse the cookie value (format: opencara_oauth_state=<value>; Path=...; ...)
    const cookieValue = stateCookie.split(';')[0];

    // Now call the callback with the correct state and code, passing the state cookie
    const callbackReq = new Request(
      `https://api.opencara.dev/auth/callback?code=test-code&state=${state}`,
      {
        headers: {
          Cookie: cookieValue,
        },
      },
    );
    const callbackRes = await ctx.workerFetch(callbackReq);

    expect(callbackRes.status).toBe(302);
    const callbackLocation = callbackRes.headers.get('Location');
    expect(callbackLocation).toContain('/dashboard');
  });

  it('session cookie set after successful callback', async () => {
    ctx.github.options.accessToken = 'gho_session_test_token';
    ctx.github.options.githubUser = {
      id: 88889,
      login: 'session-test-user',
      avatar_url: 'https://example.com/avatar2.png',
    };

    // Login to get state
    const loginRes = await ctx.workerFetch(
      new Request('https://api.opencara.dev/auth/login'),
    );
    const location = loginRes.headers.get('Location')!;
    const state = new URL(location).searchParams.get('state')!;
    const stateCookie = loginRes.headers.get('Set-Cookie')!.split(';')[0];

    // Callback
    const callbackRes = await ctx.workerFetch(
      new Request(
        `https://api.opencara.dev/auth/callback?code=test-code&state=${state}`,
        { headers: { Cookie: stateCookie } },
      ),
    );

    // Check that Set-Cookie contains opencara_session
    // The response may have multiple Set-Cookie headers. Collect all of them.
    // In Cloudflare Workers, multiple Set-Cookie headers are appended.
    // In our test, res.headers may merge them. Let's check the raw headers.
    const allCookies: string[] = [];
    callbackRes.headers.forEach((value, key) => {
      if (key.toLowerCase() === 'set-cookie') {
        allCookies.push(value);
      }
    });

    // At minimum, the joined header string should contain opencara_session
    const cookieStr = allCookies.join('; ');
    expect(cookieStr).toContain('opencara_session=');
  });

  it('missing code or state returns 400', async () => {
    // Missing both
    const req1 = new Request('https://api.opencara.dev/auth/callback');
    const res1 = await ctx.workerFetch(req1);
    expect(res1.status).toBe(400);

    // Missing state
    const req2 = new Request(
      'https://api.opencara.dev/auth/callback?code=test-code',
    );
    const res2 = await ctx.workerFetch(req2);
    expect(res2.status).toBe(400);

    // Missing code
    const req3 = new Request(
      'https://api.opencara.dev/auth/callback?state=test-state',
    );
    const res3 = await ctx.workerFetch(req3);
    expect(res3.status).toBe(400);
  });

  it('CSRF mismatch (wrong state cookie) returns 403', async () => {
    ctx.github.options.accessToken = 'gho_csrf_test_token';

    // Send callback with mismatched state
    const callbackReq = new Request(
      'https://api.opencara.dev/auth/callback?code=test-code&state=correct-state',
      {
        headers: {
          Cookie: 'opencara_oauth_state=wrong-state',
        },
      },
    );
    const res = await ctx.workerFetch(callbackReq);
    expect(res.status).toBe(403);
  });

  it('GET /auth/logout clears cookie and redirects', async () => {
    const req = new Request('https://api.opencara.dev/auth/logout');
    const res = await ctx.workerFetch(req);

    expect(res.status).toBe(302);

    const location = res.headers.get('Location');
    expect(location).toBeDefined();
    // Should redirect to the web URL
    expect(location).toBe('https://opencara.dev');

    const setCookie = res.headers.get('Set-Cookie');
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain('opencara_session=');
    expect(setCookie).toContain('Max-Age=0');
  });
});
