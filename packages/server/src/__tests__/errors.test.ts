import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { apiError, MissingBaseRefError, violatesBaseRefInvariant } from '../errors.js';

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

describe('violatesBaseRefInvariant', () => {
  it('returns false for PR task with non-empty base_ref', () => {
    expect(violatesBaseRefInvariant({ pr_number: 42, base_ref: 'main' })).toBe(false);
  });

  it('returns false for issue task (pr_number = 0) with empty base_ref', () => {
    expect(violatesBaseRefInvariant({ pr_number: 0, base_ref: '' })).toBe(false);
  });

  it('returns true for PR task with empty base_ref', () => {
    expect(violatesBaseRefInvariant({ pr_number: 42, base_ref: '' })).toBe(true);
  });

  it('returns false for negative pr_number (defensive — treated as non-PR)', () => {
    expect(violatesBaseRefInvariant({ pr_number: -1, base_ref: '' })).toBe(false);
  });
});

describe('MissingBaseRefError', () => {
  it('attaches full context and a readable message', () => {
    const err = new MissingBaseRefError({
      id: 'task-1',
      owner: 'acme',
      repo: 'widgets',
      pr_number: 42,
      feature: 'review',
    });
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('MissingBaseRefError');
    expect(err.task_id).toBe('task-1');
    expect(err.owner).toBe('acme');
    expect(err.repo).toBe('widgets');
    expect(err.pr_number).toBe(42);
    expect(err.feature).toBe('review');
    expect(err.message).toContain('acme/widgets#42');
    expect(err.message).toContain('review');
    expect(err.message).toContain('task-1');
  });
});
