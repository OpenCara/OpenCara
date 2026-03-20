import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './types.js';
import { MemoryTaskStore } from './store/memory.js';
import { KVTaskStore } from './store/kv.js';
import type { TaskStore } from './store/interface.js';
import { webhookRoutes } from './routes/webhook.js';
import { taskRoutes } from './routes/tasks.js';
import { registryRoutes } from './routes/registry.js';

/**
 * Create the Hono app with the appropriate store.
 * Exported for testing (pass a MemoryTaskStore).
 */
export function createApp(store: TaskStore) {
  const app = new Hono<{ Bindings: Env }>();

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

  // Routes
  app.route('/', webhookRoutes(store));
  app.route('/', taskRoutes(store));
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

// Cloudflare Workers entrypoint — uses KV store
const workerApp = new Hono<{ Bindings: Env }>();

// We need to create the store per-request since KV binding is on the env
workerApp.all('*', async (c) => {
  const store = c.env.TASK_STORE ? new KVTaskStore(c.env.TASK_STORE) : new MemoryTaskStore();
  const app = createApp(store);
  return app.fetch(c.req.raw, c.env, c.executionCtx);
});

export default workerApp;
