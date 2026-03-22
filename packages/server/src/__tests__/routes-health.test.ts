import { describe, it, expect } from 'vitest';
import { MemoryTaskStore } from '../store/memory.js';
import { createApp } from '../index.js';
import type { ReviewTask } from '@opencara/shared';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';

const mockEnv = {
  GITHUB_WEBHOOK_SECRET: 'test-secret',
  GITHUB_APP_ID: '12345',
  GITHUB_APP_PRIVATE_KEY: 'test-key',
  TASK_STORE: {} as KVNamespace,
  WEB_URL: 'https://test.com',
};

function makeTask(overrides: Partial<ReviewTask> = {}): ReviewTask {
  return {
    id: `task-${Math.random().toString(36).slice(2, 8)}`,
    owner: 'test-org',
    repo: 'test-repo',
    pr_number: 1,
    pr_url: 'https://github.com/test-org/test-repo/pull/1',
    diff_url: 'https://github.com/test-org/test-repo/pull/1.diff',
    base_ref: 'main',
    head_ref: 'feat/test',
    review_count: 1,
    prompt: 'Review this code.',
    timeout_at: Date.now() + 600_000,
    status: 'pending',
    github_installation_id: 999,
    config: DEFAULT_REVIEW_CONFIG,
    created_at: Date.now(),
    ...overrides,
  };
}

describe('Health Routes', () => {
  describe('GET /health', () => {
    it('returns 200 with status ok', async () => {
      const app = createApp(new MemoryTaskStore());
      const res = await app.request('/health', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual({ status: 'ok' });
    });
  });

  describe('GET /metrics', () => {
    it('returns zeros when no tasks exist', async () => {
      const app = createApp(new MemoryTaskStore());
      const res = await app.request('/metrics', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        tasks: {
          total: number;
          pending: number;
          reviewing: number;
          completed: number;
          timeout: number;
          failed: number;
        };
      };
      expect(body.tasks.total).toBe(0);
      expect(body.tasks.pending).toBe(0);
      expect(body.tasks.reviewing).toBe(0);
      expect(body.tasks.completed).toBe(0);
      expect(body.tasks.timeout).toBe(0);
      expect(body.tasks.failed).toBe(0);
    });

    it('counts tasks by status', async () => {
      const store = new MemoryTaskStore();
      await store.createTask(makeTask({ id: 't1', status: 'pending' }));
      await store.createTask(makeTask({ id: 't2', status: 'pending' }));
      await store.createTask(makeTask({ id: 't3', status: 'reviewing' }));
      await store.createTask(makeTask({ id: 't4', status: 'completed' }));
      await store.createTask(makeTask({ id: 't5', status: 'failed' }));
      await store.createTask(makeTask({ id: 't6', status: 'timeout' }));

      const app = createApp(store);
      const res = await app.request('/metrics', { method: 'GET' }, mockEnv);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        tasks: {
          total: number;
          pending: number;
          reviewing: number;
          completed: number;
          timeout: number;
          failed: number;
        };
      };
      expect(body.tasks.total).toBe(6);
      expect(body.tasks.pending).toBe(2);
      expect(body.tasks.reviewing).toBe(1);
      expect(body.tasks.completed).toBe(1);
      expect(body.tasks.failed).toBe(1);
      expect(body.tasks.timeout).toBe(1);
    });
  });
});
