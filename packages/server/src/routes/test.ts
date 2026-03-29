/**
 * Test-only API routes — bypass webhook signature verification.
 * Only mounted by createTestApp(), never in production.
 */
import { Hono } from 'hono';
import type { ReviewConfig } from '@opencara/shared';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';
import type { Env, AppVariables } from '../types.js';
import { MemoryDataStore } from '../store/memory.js';
import { createTaskForPR } from './webhook.js';
import { resetTimeoutThrottle } from './tasks.js';
import { resetRateLimits } from '../middleware/rate-limit.js';

export function testRoutes() {
  const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();

  /**
   * POST /test/events/pr — Inject a PR event without webhook signature.
   * Accepts optional `config` to override review config (merged with defaults).
   */
  app.post('/test/events/pr', async (c) => {
    const store = c.get('store');
    const logger = c.get('logger');
    const body = await c.req.json<{
      owner?: string;
      repo?: string;
      pr_number?: number;
      action?: string;
      installation_id?: number;
      base_ref?: string;
      head_ref?: string;
      draft?: boolean;
      labels?: string[];
      private?: boolean;
      config?: Partial<ReviewConfig>;
      diff_size?: number;
    }>();

    const owner = body.owner ?? 'test-org';
    const repo = body.repo ?? 'test-repo';
    const prNumber = body.pr_number ?? 1;
    const installationId = body.installation_id ?? 999;
    const baseRef = body.base_ref ?? 'main';
    const headRef = body.head_ref ?? 'feat/test';

    // Merge config with defaults
    const config: ReviewConfig = body.config
      ? { ...DEFAULT_REVIEW_CONFIG, ...body.config }
      : DEFAULT_REVIEW_CONFIG;

    const groupId = await createTaskForPR(
      store,
      installationId,
      owner,
      repo,
      prNumber,
      `https://github.com/${owner}/${repo}/pull/${prNumber}`,
      `https://github.com/${owner}/${repo}/pull/${prNumber}.diff`,
      baseRef,
      headRef,
      config,
      body.private ?? false,
      logger,
      body.diff_size,
    );

    if (!groupId) {
      return c.json({ created: false, reason: 'Active task already exists for this PR' }, 200);
    }

    // Look up tasks in the group and return the first task's ID for backward compat
    const groupTasks = await store.getTasksByGroup(groupId);
    const firstTaskId = groupTasks.length > 0 ? groupTasks[0].id : groupId;

    return c.json({ created: true, task_id: firstTaskId, group_id: groupId }, 201);
  });

  /**
   * POST /test/reset — Clear all tasks, claims, and agents. Reset throttle.
   */
  app.post('/test/reset', async (c) => {
    const store = c.get('store');
    if (store instanceof MemoryDataStore) {
      store.reset();
    }
    resetTimeoutThrottle();
    resetRateLimits();
    return c.json({ success: true });
  });

  /**
   * GET /test/tasks — List all tasks (debug view).
   */
  app.get('/test/tasks', async (c) => {
    const store = c.get('store');
    const tasks = await store.listTasks();
    return c.json({ tasks });
  });

  /**
   * GET /test/claims/:taskId — List all claims for a task.
   */
  app.get('/test/claims/:taskId', async (c) => {
    const store = c.get('store');
    const taskId = c.req.param('taskId');
    const claims = await store.getClaims(taskId);
    return c.json({ claims });
  });

  return app;
}
