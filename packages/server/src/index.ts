import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env, AppVariables } from './types.js';
import { MemoryTaskStore } from './store/memory.js';
import { KVTaskStore } from './store/kv.js';
import type { TaskStore } from './store/interface.js';
import { webhookRoutes } from './routes/webhook.js';
import { taskRoutes, checkTimeouts } from './routes/tasks.js';
import { registryRoutes } from './routes/registry.js';

type HonoApp = Hono<{ Bindings: Env; Variables: AppVariables }>;

/**
 * Build the Hono app with store injected via middleware.
 * The storeProvider callback is called per-request to produce a TaskStore.
 */
function buildApp(storeProvider: (env: Env) => TaskStore): HonoApp {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  // Inject store into every request's context
  app.use('*', async (c, next) => {
    c.set('store', storeProvider(c.env));
    await next();
  });

  // CORS
  app.use(
    '/api/*',
    cors({
      origin: '*', // No auth for now — open to all
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type'],
    }),
  );

  // Health check
  app.get('/', (c) => c.json({ status: 'ok', service: 'opencara-server' }));

  // Routes (store comes from c.get('store'))
  app.route('/', webhookRoutes());
  app.route('/', taskRoutes());
  app.route('/', registryRoutes());

  // 404
  app.notFound((c) => c.json({ error: 'Not Found' }, 404));

  // Error handler
  app.onError((err, c) => {
    console.error('Unhandled error:', err);
    return c.json({ error: 'Internal Server Error' }, 500);
  });

  return app;
}

/**
 * Create the Hono app with a specific store.
 * Used by tests (pass a MemoryTaskStore).
 */
export function createApp(store: TaskStore): HonoApp {
  return buildApp(() => store);
}

// Cloudflare Workers entrypoint — app created once at module level
const workerApp = buildApp((env) =>
  env.TASK_STORE ? new KVTaskStore(env.TASK_STORE) : new MemoryTaskStore(),
);

export default {
  fetch: workerApp.fetch,
  /**
   * Cron Trigger handler — runs timeout checks independently of poll traffic.
   * Ensures timed-out tasks are handled even during zero-traffic periods.
   */
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext): Promise<void> {
    const store = env.TASK_STORE ? new KVTaskStore(env.TASK_STORE) : new MemoryTaskStore();
    try {
      await checkTimeouts(store, env);
    } catch (err) {
      console.error(
        `[cron] action=check_timeouts_failed error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};
