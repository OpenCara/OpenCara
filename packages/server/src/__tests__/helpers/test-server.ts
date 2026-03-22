/**
 * Test server factory — creates a Hono app with test routes mounted.
 */
import { Hono } from 'hono';
import type { ErrorResponse } from '@opencara/shared';
import type { Env, AppVariables } from '../../types.js';
import type { DataStore } from '../../store/interface.js';
import { webhookRoutes } from '../../routes/webhook.js';
import { taskRoutes } from '../../routes/tasks.js';
import { registryRoutes } from '../../routes/registry.js';
import { testRoutes } from '../../routes/test.js';
import { requestIdMiddleware } from '../../middleware/request-id.js';

type HonoApp = Hono<{ Bindings: Env; Variables: AppVariables }>;

/**
 * Create a Hono app with test routes mounted.
 * Unlike `createApp()` from index.ts, this also mounts `/test/*` endpoints
 * that bypass webhook signature verification.
 */
export function createTestApp(store: DataStore): HonoApp {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  // Generate request ID and attach structured logger
  app.use('*', requestIdMiddleware());

  // Inject store
  app.use('*', async (c, next) => {
    c.set('store', store);
    await next();
  });

  // Health check
  app.get('/', (c) => c.json({ status: 'ok', service: 'opencara-server' }));

  // Production routes
  app.route('/', webhookRoutes());
  app.route('/', taskRoutes());
  app.route('/', registryRoutes());

  // Test-only routes
  app.route('/', testRoutes());

  // 404
  app.notFound((c) =>
    c.json<ErrorResponse>({ error: { code: 'INVALID_REQUEST', message: 'Not Found' } }, 404),
  );

  // Error handler
  app.onError((err, c) => {
    const logger = c.get('logger');
    logger.error('Unhandled error', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return c.json<ErrorResponse>(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } },
      500,
    );
  });

  return app;
}
