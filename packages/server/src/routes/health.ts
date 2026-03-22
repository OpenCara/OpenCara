import { Hono } from 'hono';
import type { TaskStatus } from '@opencara/shared';
import type { Env, AppVariables } from '../types.js';

export function healthRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  /** GET /health — basic health check */
  app.get('/health', (c) => c.json({ status: 'ok' }));

  /** GET /metrics — operational metrics */
  app.get('/metrics', async (c) => {
    const store = c.get('store');
    const tasks = await store.listTasks();

    const counts: Record<TaskStatus, number> = {
      pending: 0,
      reviewing: 0,
      completed: 0,
      timeout: 0,
      failed: 0,
    };
    for (const task of tasks) {
      counts[task.status]++;
    }

    return c.json({
      tasks: {
        total: tasks.length,
        pending: counts.pending,
        reviewing: counts.reviewing,
        completed: counts.completed,
        timeout: counts.timeout,
        failed: counts.failed,
      },
    });
  });

  return app;
}
