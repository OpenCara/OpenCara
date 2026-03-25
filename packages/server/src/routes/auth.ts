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

/**
 * Auth proxy routes for GitHub Device Flow.
 *
 * The server holds the client_secret so that it never needs to be embedded
 * in the CLI (a public npm package). These endpoints proxy Device Flow
 * requests to GitHub, injecting the client_id and client_secret as needed.
 */
export function authRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  // Rate limits per IP per minute
  const deviceInitLimit = rateLimitByIP({ maxRequests: 5, windowMs: 60_000 });
  const deviceTokenLimit = rateLimitByIP({ maxRequests: 10, windowMs: 60_000 });
  const refreshLimit = rateLimitByIP({ maxRequests: 10, windowMs: 60_000 });

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

    const ghRes = await fetch(GITHUB_DEVICE_CODE_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ client_id: clientId, scope: '' }),
    });

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

    const data = (await ghRes.json()) as DeviceFlowInitResponse;
    return c.json<DeviceFlowInitResponse>(data);
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
    if (!clientId) {
      return apiError(c, 500, 'INTERNAL_ERROR', 'OAuth not configured');
    }

    const ghRes = await fetch(GITHUB_OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        client_id: clientId,
        device_code: body.device_code,
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      }),
    });

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

    return c.json<DeviceFlowTokenResponse>({
      access_token: data.access_token as string,
      refresh_token: data.refresh_token as string,
      expires_in: data.expires_in as number,
      token_type: data.token_type as string,
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

    const ghRes = await fetch(GITHUB_OAUTH_TOKEN_URL, {
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

    return c.json<RefreshTokenResponse>({
      access_token: data.access_token as string,
      refresh_token: data.refresh_token as string,
      expires_in: data.expires_in as number,
      token_type: data.token_type as string,
    });
  });

  return app;
}
