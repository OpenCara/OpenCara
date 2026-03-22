import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ErrorResponse } from '@opencara/shared';
import type { Env, AppVariables } from './types.js';
import { MemoryTaskStore } from './store/memory.js';
import { KVTaskStore } from './store/kv.js';
import type { TaskStore } from './store/interface.js';
import { webhookRoutes } from './routes/webhook.js';
import { taskRoutes, checkTimeouts } from './routes/tasks.js';
import { registryRoutes } from './routes/registry.js';
import { healthRoutes } from './routes/health.js';

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
  app.route('/', healthRoutes());

  // 404
  app.notFound((c) =>
    c.json<ErrorResponse>({ error: { code: 'INVALID_REQUEST', message: 'Not Found' } }, 404),
  );

  // Error handler
  app.onError((err, c) => {
    console.error('Unhandled error:', err);
    return c.json<ErrorResponse>(
      { error: { code: 'INTERNAL_ERROR', message: 'Internal Server Error' } },
      500,
    );
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

/** Parse TASK_TTL_DAYS from env, defaulting to 7. */
export function parseTtlDays(env: Env): number {
  if (!env.TASK_TTL_DAYS) return 7;
  const parsed = parseInt(env.TASK_TTL_DAYS, 10);
  return Number.isNaN(parsed) || parsed < 1 ? 7 : parsed;
}

function createStore(env: Env): TaskStore {
  const ttlDays = parseTtlDays(env);
  return env.TASK_STORE ? new KVTaskStore(env.TASK_STORE, ttlDays) : new MemoryTaskStore(ttlDays);
}

// Cloudflare Workers entrypoint — app created once at module level
const workerApp = buildApp(createStore);

export default {
  fetch: workerApp.fetch,
  /** Cloudflare Cron Trigger handler — checks for timed-out tasks and cleans up stale entries. */
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const store = createStore(env);

    try {
      await store.setTimeoutLastCheck(Date.now());
      await checkTimeouts(store, env);
    } catch (err) {
      console.error(
        `[scheduled] action=check_timeouts error=${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const deleted = await store.cleanupTerminalTasks();
      if (deleted > 0) {
        console.log(`[scheduled] action=cleanup_terminal deleted=${deleted}`);
      }
    } catch (err) {
      console.error(
        `[scheduled] action=cleanup_terminal error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  },
};
