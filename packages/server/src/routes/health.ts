import { Hono } from 'hono';
import type { Env, AppVariables } from '../types.js';

export function healthRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  /** GET /health — basic health check */
  app.get('/health', (c) => c.json({ status: 'ok' }));

  /** GET /metrics — operational metrics */
  app.get('/metrics', async (c) => {
    const store = c.get('store');
    const tasks = await store.listTasks();

    const counts: Record<string, number> = {
      pending: 0,
      reviewing: 0,
      completed: 0,
      timeout: 0,
      failed: 0,
    };
    for (const task of tasks) {
      counts[task.status] = (counts[task.status] ?? 0) + 1;
    }

    return c.json({
      tasks: {
        total: tasks.length,
        ...counts,
      },
    });
  });

  return app;
}
