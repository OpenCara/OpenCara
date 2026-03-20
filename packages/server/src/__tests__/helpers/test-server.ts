/**
 * Test server factory — creates a Hono app with test routes mounted.
 */
import { Hono } from 'hono';
import type { Env, AppVariables } from '../../types.js';
import type { TaskStore } from '../../store/interface.js';
import { webhookRoutes } from '../../routes/webhook.js';
import { taskRoutes } from '../../routes/tasks.js';
import { registryRoutes } from '../../routes/registry.js';
import { testRoutes } from '../../routes/test.js';

type HonoApp = Hono<{ Bindings: Env; Variables: AppVariables }>;

/**
 * Create a Hono app with test routes mounted.
 * Unlike `createApp()` from index.ts, this also mounts `/test/*` endpoints
 * that bypass webhook signature verification.
 */
export function createTestApp(store: TaskStore): HonoApp {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

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
  app.notFound((c) => c.json({ error: 'Not Found' }, 404));

  // Error handler
  app.onError((err, c) => {
    console.error('Unhandled error:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  return app;
}
