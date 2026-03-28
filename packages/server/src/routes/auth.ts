import { Hono } from 'hono';
import type {
  DeviceFlowInitResponse,
  DeviceFlowTokenResponse,
  RefreshTokenResponse,
} from '@opencara/shared';
import type { Env, AppVariables } from '../types.js';
import { DeviceFlowTokenRequestSchema, RefreshTokenRequestSchema, parseBody } from '../schemas.js';
import { apiError } from '../errors.js';
import { rateLimitByIP } from '../middleware/rate-limit.js';

const GITHUB_DEVICE_CODE_URL = 'https://github.com/login/device/code';
const GITHUB_OAUTH_TOKEN_URL = 'https://github.com/login/oauth/access_token';

/** Timeout for GitHub OAuth proxy calls (10 seconds). */
const OAUTH_PROXY_TIMEOUT_MS = 10_000;

/** Safely fetch a URL with timeout, returning null on network/timeout errors. */
async function safeFetch(url: string, init: RequestInit): Promise<Response | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OAUTH_PROXY_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Validate that a token response from GitHub has the expected shape. */
function isValidTokenResponse(data: Record<string, unknown>): data is {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type: string;
} {
  return (
    typeof data.access_token === 'string' && typeof data.token_type === 'string'
    // expires_in is optional — present for GitHub Apps but absent for OAuth Apps
    // refresh_token is optional — GitHub Apps include it, but we don't require it
  );
}

/**
 * Auth proxy routes for GitHub Device Flow.
 *
 * The server holds the client_secret so that it never needs to be embedded
 * in the CLI (a public npm package). These endpoints proxy Device Flow
 * requests to GitHub, injecting the client_id and client_secret as needed.
 */
export function authRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  // Rate limits per IP per minute — distinct prefixes prevent cross-endpoint contamination
  const deviceInitLimit = rateLimitByIP({
    maxRequests: 5,
    windowMs: 60_000,
    prefix: 'auth:device',
  });
  const deviceTokenLimit = rateLimitByIP({
    maxRequests: 10,
    windowMs: 60_000,
    prefix: 'auth:device_token',
  });
  const refreshLimit = rateLimitByIP({
    maxRequests: 10,
    windowMs: 60_000,
    prefix: 'auth:refresh',
  });

  /**
   * POST /api/auth/device — Initiate GitHub Device Flow.
   *
   * Proxies to GitHub's device/code endpoint with the server's client_id.
   * No request body needed from the client.
   */
  app.post('/api/auth/device', deviceInitLimit, async (c) => {
    const clientId = c.env.GITHUB_CLIENT_ID;
    if (!clientId) {
      return apiError(c, 500, 'INTERNAL_ERROR', 'OAuth not configured');
    }

    const ghRes = await safeFetch(GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ client_id: clientId, scope: '' }),
    });

    if (!ghRes) {
      const logger = c.get('logger');
      logger.error('GitHub device flow network error', { action: 'auth_device_init' });
      return apiError(c, 500, 'INTERNAL_ERROR', 'Failed to initiate device flow');
    }

    if (!ghRes.ok) {
      const logger = c.get('logger');
      const text = await ghRes.text();
      logger.error('GitHub device flow initiation failed', {
        action: 'auth_device_init',
        status: ghRes.status,
        body: text,
      });
      return apiError(c, 500, 'INTERNAL_ERROR', 'Failed to initiate device flow');
    }

    const data = (await ghRes.json()) as Record<string, unknown>;

    // Validate response shape
    if (typeof data.device_code !== 'string' || typeof data.user_code !== 'string') {
      const logger = c.get('logger');
      logger.error('GitHub returned invalid device flow response', {
        action: 'auth_device_init',
      });
      return apiError(c, 500, 'INTERNAL_ERROR', 'Invalid response from GitHub');
    }

    return c.json<DeviceFlowInitResponse>({
      device_code: data.device_code,
      user_code: data.user_code,
      verification_uri: data.verification_uri as string,
      expires_in: data.expires_in as number,
      interval: data.interval as number,
    });
  });

  /**
   * POST /api/auth/device/token — Poll for device flow token.
   *
   * Proxies to GitHub's access_token endpoint with the server's client_id
   * and the client-provided device_code. No client_secret needed for this step.
   */
  app.post('/api/auth/device/token', deviceTokenLimit, async (c) => {
    const body = await parseBody(c, DeviceFlowTokenRequestSchema);
    if (body instanceof Response) return body;

    const clientId = c.env.GITHUB_CLIENT_ID;
    const clientSecret = c.env.GITHUB_CLIENT_SECRET;
    if (!clientId) {
      return apiError(c, 500, 'INTERNAL_ERROR', 'OAuth not configured');
    }

    const tokenBody: Record<string, string> = {
      client_id: clientId,
      device_code: body.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    };
    // Include client_secret if configured (required for GitHub Apps)
    if (clientSecret) {
      tokenBody.client_secret = clientSecret;
    }

    const ghRes = await safeFetch(GITHUB_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(tokenBody),
    });

    if (!ghRes) {
      const logger = c.get('logger');
      logger.error('GitHub device token network error', { action: 'auth_device_token' });
      return apiError(c, 500, 'INTERNAL_ERROR', 'Failed to poll for token');
    }

    if (!ghRes.ok) {
      const logger = c.get('logger');
      const text = await ghRes.text();
      logger.error('GitHub device token poll failed', {
        action: 'auth_device_token',
        status: ghRes.status,
        body: text,
      });
      return apiError(c, 500, 'INTERNAL_ERROR', 'Failed to poll for token');
    }

    const data = (await ghRes.json()) as Record<string, unknown>;

    // GitHub returns error conditions as 200 with an "error" field
    if (data.error) {
      return c.json(
        {
          error: data.error as string,
          error_description: (data.error_description as string) ?? undefined,
        },
        200,
      );
    }

    if (!isValidTokenResponse(data)) {
      const logger = c.get('logger');
      // Log response shape for debugging (keys + types only, no values for security)
      const shape = Object.fromEntries(Object.entries(data).map(([k, v]) => [k, typeof v]));
      logger.error('GitHub returned invalid token response', {
        action: 'auth_device_token',
        responseShape: shape,
      });
      return apiError(
        c,
        500,
        'INTERNAL_ERROR',
        `Invalid token response from GitHub (keys: ${Object.keys(data).join(', ')})`,
      );
    }

    // Default expires_in to 8 hours if not provided (OAuth Apps don't include it)
    const DEFAULT_EXPIRES_IN = 8 * 60 * 60;

    return c.json<DeviceFlowTokenResponse>({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in: typeof data.expires_in === 'number' ? data.expires_in : DEFAULT_EXPIRES_IN,
      token_type: data.token_type,
    });
  });

  /**
   * POST /api/auth/refresh — Refresh an expired token.
   *
   * Proxies to GitHub's access_token endpoint with the server's client_id,
   * client_secret, and the client-provided refresh_token.
   */
  app.post('/api/auth/refresh', refreshLimit, async (c) => {
    const body = await parseBody(c, RefreshTokenRequestSchema);
    if (body instanceof Response) return body;

    const clientId = c.env.GITHUB_CLIENT_ID;
    const clientSecret = c.env.GITHUB_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      return apiError(c, 500, 'INTERNAL_ERROR', 'OAuth not configured');
    }

    const ghRes = await safeFetch(GITHUB_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: body.refresh_token,
      }),
    });

    if (!ghRes) {
      const logger = c.get('logger');
      logger.error('GitHub token refresh network error', { action: 'auth_refresh' });
      return apiError(c, 500, 'INTERNAL_ERROR', 'Failed to refresh token');
    }

    if (!ghRes.ok) {
      const logger = c.get('logger');
      const text = await ghRes.text();
      logger.error('GitHub token refresh failed', {
        action: 'auth_refresh',
        status: ghRes.status,
        body: text,
      });
      return apiError(c, 500, 'INTERNAL_ERROR', 'Failed to refresh token');
    }

    const data = (await ghRes.json()) as Record<string, unknown>;

    // GitHub returns error conditions as 200 with an "error" field
    if (data.error) {
      return c.json(
        {
          error: data.error as string,
          error_description: (data.error_description as string) ?? undefined,
        },
        200,
      );
    }

    if (!isValidTokenResponse(data)) {
      const logger = c.get('logger');
      logger.error('GitHub returned invalid token response', { action: 'auth_refresh' });
      return apiError(c, 500, 'INTERNAL_ERROR', 'Invalid token response from GitHub');
    }

    const DEFAULT_EXPIRES_IN_REFRESH = 8 * 60 * 60;

    return c.json<RefreshTokenResponse>({
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_in:
        typeof data.expires_in === 'number' ? data.expires_in : DEFAULT_EXPIRES_IN_REFRESH,
      token_type: data.token_type,
    });
  });

  return app;
}
