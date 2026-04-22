import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { apiError, MissingBaseRefError, assertTaskInvariants } from '../errors.js';

describe('apiError', () => {
  it('returns structured error with correct status and body', async () => {
    const app = new Hono();
    app.get('/test', (c) => apiError(c, 400, 'INVALID_REQUEST', 'Missing field'));

    const res = await app.request('/test');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body).toEqual({
      error: {
        code: 'INVALID_REQUEST',
        message: 'Missing field',
      },
    });
  });

  it('returns 404 with TASK_NOT_FOUND', async () => {
    const app = new Hono();
    app.get('/test', (c) => apiError(c, 404, 'TASK_NOT_FOUND', 'Task not found'));

    const res = await app.request('/test');
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error.code).toBe('TASK_NOT_FOUND');
  });

  it('returns 429 with RATE_LIMITED', async () => {
    const app = new Hono();
    app.get('/test', (c) => apiError(c, 429, 'RATE_LIMITED', 'Too many requests'));

    const res = await app.request('/test');
    expect(res.status).toBe(429);
    const body = await res.json();
    expect(body.error.code).toBe('RATE_LIMITED');
  });

  it('returns 500 with INTERNAL_ERROR', async () => {
    const app = new Hono();
    app.get('/test', (c) => apiError(c, 500, 'INTERNAL_ERROR', 'Something went wrong'));

    const res = await app.request('/test');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error.code).toBe('INTERNAL_ERROR');
    expect(body.error.message).toBe('Something went wrong');
  });
});

describe('assertTaskInvariants', () => {
  const prTask = {
    id: 'task-1',
    owner: 'acme',
    repo: 'widgets',
    pr_number: 42,
    base_ref: 'main',
    feature: 'review',
  };
  const issueTask = {
    id: 'task-2',
    owner: 'acme',
    repo: 'widgets',
    pr_number: 0,
    base_ref: '',
    feature: 'triage',
  };

  it('accepts a PR task with a non-empty base_ref', () => {
    expect(() => assertTaskInvariants(prTask)).not.toThrow();
  });

  it('accepts an issue task (pr_number = 0) with an empty base_ref', () => {
    expect(() => assertTaskInvariants(issueTask)).not.toThrow();
  });

  it('throws MissingBaseRefError for a PR task with empty base_ref', () => {
    expect(() => assertTaskInvariants({ ...prTask, base_ref: '' })).toThrow(MissingBaseRefError);
  });

  it('attaches full context to the error', () => {
    try {
      assertTaskInvariants({ ...prTask, base_ref: '' });
      throw new Error('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingBaseRefError);
      const e = err as MissingBaseRefError;
      expect(e.task_id).toBe('task-1');
      expect(e.owner).toBe('acme');
      expect(e.repo).toBe('widgets');
      expect(e.pr_number).toBe(42);
      expect(e.feature).toBe('review');
      expect(e.name).toBe('MissingBaseRefError');
      expect(e.message).toContain('acme/widgets#42');
      expect(e.message).toContain('review');
      expect(e.message).toContain('task-1');
    }
  });
});
