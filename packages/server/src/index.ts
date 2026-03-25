import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ErrorResponse } from '@opencara/shared';
import type { Env, AppVariables } from './types.js';
import { MemoryDataStore } from './store/memory.js';
import { D1DataStore } from './store/d1.js';
import type { DataStore } from './store/interface.js';
import type { GitHubService } from './github/service.js';
import { RealGitHubService, NoOpGitHubService } from './github/service.js';
import { webhookRoutes } from './routes/webhook.js';
import { taskRoutes, checkTimeouts } from './routes/tasks.js';
import { registryRoutes } from './routes/registry.js';
import { metaRoutes } from './routes/meta.js';
import { healthRoutes } from './routes/health.js';
import { configRoutes } from './routes/config.js';
import { requestIdMiddleware } from './middleware/request-id.js';
import { versionCheck } from './middleware/version-check.js';
import { createLogger } from './logger.js';

export type HonoApp = Hono<{ Bindings: Env; Variables: AppVariables }>;

/**
 * Build the Hono app with store and GitHubService injected via middleware.
 * Provider callbacks are called per-request so that env bindings (available
 * only at request time in CF Workers) can be used for construction.
 * Exported for the Node.js entry point.
 */
export function buildApp(
  storeProvider: (env: Env) => DataStore,
  githubProvider: (env: Env) => GitHubService,
): HonoApp {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  // Generate request ID and attach structured logger
  app.use('*', requestIdMiddleware());

  // Inject store and GitHub service into every request's context
  app.use('*', async (c, next) => {
    c.set('store', storeProvider(c.env));
    c.set('github', githubProvider(c.env));
    await next();
  });

  // CORS
  app.use(
    '/api/*',
    cors({
      origin: '*',
      allowMethods: ['GET', 'POST', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'X-OpenCara-CLI-Version'],
    }),
  );

  // Version check on task endpoints — reject outdated CLIs
  app.use('/api/tasks/*', versionCheck());

  // Health check
  app.get('/', (c) => c.json({ status: 'ok', service: 'opencara-server' }));

  // Routes (store comes from c.get('store'))
  app.route('/', webhookRoutes());
  app.route('/', taskRoutes());
  app.route('/', registryRoutes());
  app.route('/', metaRoutes());
  app.route('/', healthRoutes());
  app.route('/', configRoutes());

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
 * Create the Hono app with a specific store and optional GitHubService.
 * Used by tests (pass a MemoryDataStore + NoOpGitHubService).
 */
export function createApp(store: DataStore, githubService?: GitHubService): HonoApp {
  const svc = githubService ?? new NoOpGitHubService();
  return buildApp(
    () => store,
    () => svc,
  );
}

/** Parse TASK_TTL_DAYS from env, defaulting to 7. */
export function parseTtlDays(env: Env): number {
  if (!env.TASK_TTL_DAYS) return 7;
  const parsed = parseInt(env.TASK_TTL_DAYS, 10);
  return Number.isNaN(parsed) || parsed < 1 ? 7 : parsed;
}

/** @internal Exported for testing only. */
export function createStore(env: Env): DataStore {
  const ttlDays = parseTtlDays(env);
  // D1 (preferred) → Memory (dev/test)
  if (env.DB) return new D1DataStore(env.DB, ttlDays);
  return new MemoryDataStore(ttlDays);
}

/** @internal Create a GitHubService from CF Workers env bindings. */
export function createGitHubService(env: Env): GitHubService {
  return new RealGitHubService(env.GITHUB_APP_ID, env.GITHUB_APP_PRIVATE_KEY);
}

// Cloudflare Workers entrypoint — app created once at module level
const workerApp = buildApp(createStore, createGitHubService);

export default {
  fetch: workerApp.fetch,
  /** Cloudflare Cron Trigger handler — checks for timed-out tasks and cleans up stale entries. */
  async scheduled(_event: { scheduledTime: number; cron: string }, env: Env): Promise<void> {
    const store = createStore(env);
    const github = createGitHubService(env);
    const logger = createLogger();

    try {
      await store.setTimeoutLastCheck(Date.now());
      await checkTimeouts(store, github, logger);
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
