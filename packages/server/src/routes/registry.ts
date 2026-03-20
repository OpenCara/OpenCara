import { Hono } from 'hono';
import { DEFAULT_REGISTRY } from '@opencara/shared';
import type { Env } from '../types.js';

export function registryRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/api/registry', (c) => {
    return c.json(DEFAULT_REGISTRY);
  });

  return app;
}
