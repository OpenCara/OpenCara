import type { SupabaseClient } from '@supabase/supabase-js';
import { generateApiKey, hashApiKey, parseCookies } from '../auth.js';
import type { Env } from '../env.js';

const SESSION_COOKIE_NAME = 'opencara_session';
const STATE_COOKIE_NAME = 'opencara_oauth_state';
const SESSION_MAX_AGE = 30 * 24 * 60 * 60; // 30 days in seconds
const STATE_MAX_AGE = 300; // 5 minutes in seconds

/** Generate a random hex string for CSRF state */
async function generateState(): Promise<string> {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/** Build a Set-Cookie header value */
function buildCookie(
  name: string,
  value: string,
  options: {
    maxAge?: number;
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: 'Lax' | 'Strict' | 'None';
    path?: string;
  },
): string {
  const parts = [`${name}=${value}`];
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join('; ');
}

/** GET /auth/login — redirect to GitHub OAuth */
export async function handleWebLogin(request: Request, env: Env): Promise<Response> {
  const state = await generateState();
  const callbackUrl = `${env.WORKER_URL}/auth/callback`;

  const githubUrl = new URL('https://github.com/login/oauth/authorize');
  githubUrl.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  githubUrl.searchParams.set('redirect_uri', callbackUrl);
  githubUrl.searchParams.set('scope', 'read:user');
  githubUrl.searchParams.set('state', state);

  const stateCookie = buildCookie(STATE_COOKIE_NAME, state, {
    maxAge: STATE_MAX_AGE,
    httpOnly: true,
    secure: isSecureRequest(request),
    sameSite: 'Lax',
    path: '/',
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: githubUrl.toString(),
      'Set-Cookie': stateCookie,
    },
  });
}

/** GET /auth/callback?code=xxx&state=xxx — handle GitHub OAuth redirect */
export async function handleWebCallback(
  request: Request,
  env: Env,
  supabase: SupabaseClient,
): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');

  if (!code || !state) {
    return jsonResponse({ error: 'Missing code or state parameter' }, 400);
  }

  // Validate CSRF state
  const cookies = parseCookies(request.headers.get('Cookie'));
  const storedState = cookies[STATE_COOKIE_NAME];

  if (!storedState || storedState !== state) {
    return jsonResponse({ error: 'Invalid state parameter (CSRF check failed)' }, 403);
  }

  // Exchange code for access token
  const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  if (!tokenResponse.ok) {
    return jsonResponse({ error: 'Failed to exchange code for token' }, 502);
  }

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    error?: string;
  };

  if (tokenData.error || !tokenData.access_token) {
    return jsonResponse({ error: 'GitHub OAuth error' }, 502);
  }

  // Fetch GitHub user profile
  const userResponse = await fetch('https://api.github.com/user', {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: 'application/json',
      'User-Agent': 'OpenCara',
    },
  });

  if (!userResponse.ok) {
    return jsonResponse({ error: 'Failed to fetch user profile' }, 502);
  }

  const githubUser = (await userResponse.json()) as {
    id: number;
    login: string;
    avatar_url: string;
  };

  // Generate API key
  const apiKey = await generateApiKey();
  const apiKeyHash = await hashApiKey(apiKey);

  // Upsert user
  const { error: upsertError } = await supabase.from('users').upsert(
    {
      github_id: githubUser.id,
      name: githubUser.login,
      avatar: githubUser.avatar_url,
      api_key_hash: apiKeyHash,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'github_id' },
  );

  if (upsertError) {
    return jsonResponse({ error: 'Failed to save user' }, 500);
  }

  const secure = isSecureRequest(request);
  const webUrl = env.WEB_URL || 'http://localhost:3000';

  // Set session cookie and clear state cookie
  const sessionCookie = buildCookie(SESSION_COOKIE_NAME, apiKey, {
    maxAge: SESSION_MAX_AGE,
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
  });

  const clearStateCookie = buildCookie(STATE_COOKIE_NAME, '', {
    maxAge: 0,
    httpOnly: true,
    secure,
    sameSite: 'Lax',
    path: '/',
  });

  const headers = new Headers();
  headers.set('Location', `${webUrl}/dashboard`);
  headers.append('Set-Cookie', sessionCookie);
  headers.append('Set-Cookie', clearStateCookie);

  return new Response(null, {
    status: 302,
    headers,
  });
}

/** GET /auth/logout — clear session cookie and redirect */
export async function handleWebLogout(request: Request, env: Env): Promise<Response> {
  const webUrl = env.WEB_URL || 'http://localhost:3000';

  const clearCookie = buildCookie(SESSION_COOKIE_NAME, '', {
    maxAge: 0,
    httpOnly: true,
    secure: isSecureRequest(request),
    sameSite: 'Lax',
    path: '/',
  });

  return new Response(null, {
    status: 302,
    headers: {
      Location: webUrl,
      'Set-Cookie': clearCookie,
    },
  });
}

function isSecureRequest(request: Request): boolean {
  return new URL(request.url).protocol === 'https:';
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
