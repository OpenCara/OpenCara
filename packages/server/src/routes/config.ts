import { Hono } from 'hono';
import type { ConfigValidateResponse } from '@opencara/shared';
import { parseReviewConfig } from '@opencara/shared';
import type { Env, AppVariables } from '../types.js';
import { rateLimitByIP } from '../middleware/rate-limit.js';
import { apiError } from '../errors.js';

export function configRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  app.post(
    '/api/config/validate',
    rateLimitByIP({ maxRequests: 60, windowMs: 60_000 }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return apiError(c, 400, 'INVALID_REQUEST', 'Malformed request body');
      }

      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return apiError(c, 400, 'INVALID_REQUEST', 'Request body must be a JSON object');
      }

      const { toml } = body as { toml?: unknown };

      if (typeof toml !== 'string') {
        return apiError(c, 400, 'INVALID_REQUEST', 'Field "toml" is required and must be a string');
      }

      const result = parseReviewConfig(toml);

      if ('error' in result) {
        return c.json<ConfigValidateResponse>({ valid: false, error: result.error }, 200);
      }

      return c.json<ConfigValidateResponse>({ valid: true, config: result }, 200);
    },
  );

  return app;
}
