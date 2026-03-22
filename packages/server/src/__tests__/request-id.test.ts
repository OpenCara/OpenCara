import { describe, it, expect, vi, afterEach } from 'vitest';
import { Hono } from 'hono';
import type { Env, AppVariables } from '../types.js';
import { requestIdMiddleware } from '../middleware/request-id.js';
import { Logger } from '../logger.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('requestIdMiddleware', () => {
  function createTestApp() {
    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', requestIdMiddleware());
    app.get('/test', (c) => {
      const requestId = c.get('requestId');
      const logger = c.get('logger');
      return c.json({ requestId, hasLogger: logger instanceof Logger });
    });
    return app;
  }

  it('sets X-Request-Id response header', async () => {
    const app = createTestApp();
    const res = await app.request('/test');
    const requestId = res.headers.get('X-Request-Id');
    expect(requestId).toBeTruthy();
    expect(requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('injects requestId into context', async () => {
    const app = createTestApp();
    const res = await app.request('/test');
    const body = await res.json();
    expect(body.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('injects Logger instance into context', async () => {
    const app = createTestApp();
    const res = await app.request('/test');
    const body = await res.json();
    expect(body.hasLogger).toBe(true);
  });

  it('generates unique IDs for different requests', async () => {
    const app = createTestApp();
    const res1 = await app.request('/test');
    const res2 = await app.request('/test');
    const id1 = res1.headers.get('X-Request-Id');
    const id2 = res2.headers.get('X-Request-Id');
    expect(id1).not.toBe(id2);
  });

  it('logger uses the same requestId as the header', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const app = new Hono<{ Bindings: Env; Variables: AppVariables }>();
    app.use('*', requestIdMiddleware());
    app.get('/test-log', (c) => {
      const logger = c.get('logger');
      logger.info('Test log entry');
      return c.json({ requestId: c.get('requestId') });
    });

    const res = await app.request('/test-log');
    const body = await res.json();
    const headerRequestId = res.headers.get('X-Request-Id');

    expect(body.requestId).toBe(headerRequestId);

    // Verify the logger emitted the same requestId
    const logCall = (console.log as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const entry = JSON.parse(logCall);
    expect(entry.requestId).toBe(headerRequestId);
  });
});
