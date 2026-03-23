import { Hono } from 'hono';
import type { Env, AppVariables } from '../types.js';

export function healthRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  /** GET /health — basic health check */
  app.get('/health', (c) => c.json({ status: 'ok' }));

  /**
   * GET /metrics — operational metrics.
   *
   * Only active tasks (pending/reviewing) remain in the store — completed
   * and timed-out tasks are deleted immediately after the review is posted
   * to GitHub. Failed tasks stay briefly for retry by checkTimeouts.
   */
  app.get('/metrics', async (c) => {
    const store = c.get('store');
    const tasks = await store.listTasks();

    let pending = 0;
    let reviewing = 0;
    let failed = 0;
    for (const task of tasks) {
      if (task.status === 'pending') pending++;
      else if (task.status === 'reviewing') reviewing++;
      else if (task.status === 'failed') failed++;
    }

    return c.json({
      tasks: {
        total: tasks.length,
        pending,
        reviewing,
        failed,
      },
    });
  });

  return app;
}
