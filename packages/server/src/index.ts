import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ErrorResponse } from '@opencara/shared';
import type { Env, AppVariables } from './types.js';
import { MemoryDataStore } from './store/memory.js';
import { KVDataStore } from './store/kv.js';
import type { DataStore } from './store/interface.js';
import { webhookRoutes } from './routes/webhook.js';
import { taskRoutes, checkTimeouts } from './routes/tasks.js';
import { registryRoutes } from './routes/registry.js';
import { healthRoutes } from './routes/health.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { createLogger } from './logger.js';

type HonoApp = Hono<{ Bindings: Env; Variables: AppVariables }>;

/**
 * Build the Hono app with store injected via middleware.
 * The storeProvider callback is called per-request to produce a DataStore.
 */
function buildApp(storeProvider: (env: Env) => DataStore): HonoApp {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  // Generate request ID and attach structured logger
  app.use('*', requestIdMiddleware());

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

/**
 * Create the Hono app with a specific store.
 * Used by tests (pass a MemoryDataStore).
 */
export function createApp(store: DataStore): HonoApp {
  return buildApp(() => store);
}

/** Parse TASK_TTL_DAYS from env, defaulting to 7. */
export function parseTtlDays(env: Env): number {
  if (!env.TASK_TTL_DAYS) return 7;
  const parsed = parseInt(env.TASK_TTL_DAYS, 10);
  return Number.isNaN(parsed) || parsed < 1 ? 7 : parsed;
}

function createStore(env: Env): DataStore {
  const ttlDays = parseTtlDays(env);
  return env.TASK_STORE ? new KVDataStore(env.TASK_STORE, ttlDays) : new MemoryDataStore(ttlDays);
}

// Cloudflare Workers entrypoint — app created once at module level
const workerApp = buildApp(createStore);

export default {
  fetch: workerApp.fetch,
  /** Cloudflare Cron Trigger handler — checks for timed-out tasks and cleans up stale entries. */
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const store = createStore(env);
    const logger = createLogger();

    try {
      await store.setTimeoutLastCheck(Date.now());
      await checkTimeouts(store, env);
    } catch (err) {
      logger.error('Scheduled timeout check failed', {
        action: 'check_timeouts',
        error: err instanceof Error ? err.message : String(err),
      });
    }

    try {
      const deleted = await store.cleanupTerminalTasks();
      if (deleted > 0) {
        logger.info('Cleaned up terminal tasks', { action: 'cleanup_terminal', deleted });
      }
    } catch (err) {
      logger.error('Scheduled terminal cleanup failed', {
        action: 'cleanup_terminal',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  },
};
