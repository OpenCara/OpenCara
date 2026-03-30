import type { MiddlewareHandler } from 'hono';
import type { VerifiedIdentity, ErrorResponse } from '@opencara/shared';
import type { Env, AppVariables } from '../types.js';

/** Default cache TTL: 1 hour in milliseconds. */
export const OAUTH_CACHE_TTL_MS = 60 * 60 * 1000;

/** Timeout for GitHub token verification API calls (10 seconds). */
const OAUTH_VERIFY_TIMEOUT_MS = 10_000;

/** In-memory hash cache to avoid re-computing SHA-256 on every request for the same token. */
const hashCache = new Map<string, string>();

/**
 * Hash a token using SHA-256. Returns hex-encoded digest.
 * Uses the Web Crypto API available in Cloudflare Workers and Node 18+.
 * Results are cached in-memory for the lifetime of the worker/process.
 */
export async function hashToken(token: string): Promise<string> {
  const cached = hashCache.get(token);
  if (cached) return cached;
  const encoder = new TextEncoder();
  const data = encoder.encode(token);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  const hex = Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  hashCache.set(token, hex);
  return hex;
}

/**
 * Verify a GitHub user-access token via POST /applications/{client_id}/token.
 * Uses Basic auth with client_id:client_secret.
 *
 * Returns the verified identity on success, or null if the token is invalid/revoked.
 * Throws on network errors or unexpected API responses.
 */
export async function verifyGitHubToken(
  token: string,
  clientId: string,
  clientSecret: string,
): Promise<
  { identity: VerifiedIdentity; valid: true } | { valid: false; reason: 'revoked' | 'expired' }
> {
  const credentials = btoa(`${clientId}:${clientSecret}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_VERIFY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`https://api.github.com/applications/${clientId}/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/json',
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'OpenCara-Server',
      },
      body: JSON.stringify({ access_token: token }),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 200) {
    const data = (await response.json()) as { user?: { id: number; login: string } };
    if (!data.user) {
      return { valid: false, reason: 'revoked' };
    }
    return {
      valid: true,
      identity: {
        github_user_id: data.user.id,
        github_username: data.user.login,
        verified_at: Date.now(),
      },
    };
  }

  if (response.status === 404) {
    // Token is invalid or revoked
    return { valid: false, reason: 'revoked' };
  }

  if (response.status === 422) {
    // Token expired
    return { valid: false, reason: 'expired' };
  }

  // Unexpected status — treat as a transient error
  const body = await response.text().catch(() => '');
  throw new Error(`GitHub token verification failed with status ${response.status}: ${body}`);
}

/**
 * Middleware: extract and verify GitHub OAuth user-access token.
 *
 * Flow:
 * 1. Extract Bearer token from Authorization header
 * 2. Check D1 cache: hash(token) -> VerifiedIdentity (TTL: 1hr)
 * 3. If cache miss/expired: verify via GitHub API POST /applications/{client_id}/token
 * 4. Store verified identity in Hono context for route handlers
 * 5. Return 401 with appropriate error code on failure
 */
export function requireOAuth(): MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> {
  return async (c, next) => {
    const clientId = c.env.GITHUB_CLIENT_ID;
    const clientSecret = c.env.GITHUB_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      // OAuth not configured — this is a server misconfiguration
      c.get('logger').error('OAuth middleware requires GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET');
      return c.json<ErrorResponse>(
        { error: { code: 'INTERNAL_ERROR', message: 'OAuth not configured' } },
        500,
      );
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader) {
      return c.json<ErrorResponse>(
        { error: { code: 'AUTH_REQUIRED', message: 'Missing Authorization header' } },
        401,
      );
    }

    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (!match) {
      return c.json<ErrorResponse>(
        { error: { code: 'AUTH_REQUIRED', message: 'Invalid Authorization header format' } },
        401,
      );
    }

    const token = match[1].trim();
    const tokenHash = await hashToken(token);
    const store = c.get('store');

    try {
      // Check cache first
      const cached = await store.getOAuthCache(tokenHash);
      if (cached) {
        c.set('verifiedIdentity', cached);
        await next();
        return;
      }

      // Cache miss — verify with GitHub
      const result = await verifyGitHubToken(token, clientId, clientSecret);

      if (!result.valid) {
        const code = result.reason === 'expired' ? 'AUTH_TOKEN_EXPIRED' : 'AUTH_TOKEN_REVOKED';
        const message =
          result.reason === 'expired'
            ? 'OAuth token has expired — please refresh'
            : 'OAuth token is invalid or revoked';
        return c.json<ErrorResponse>({ error: { code, message } }, 401);
      }

      // Cache the verified identity (best-effort — don't fail the request on write error)
      try {
        await store.setOAuthCache(tokenHash, result.identity, OAUTH_CACHE_TTL_MS);
      } catch (cacheErr) {
        c.get('logger').warn('OAuth cache write failed (non-fatal)', {
          error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
        });
      }
      c.set('verifiedIdentity', result.identity);
      await next();
    } catch (err) {
      c.get('logger').error('GitHub token verification error', {
        error: err instanceof Error ? err.message : String(err),
      });
      return c.json<ErrorResponse>(
        { error: { code: 'INTERNAL_ERROR', message: 'Token verification failed' } },
        500,
      );
    }
  };
}
