import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { apiError } from '../errors.js';

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
