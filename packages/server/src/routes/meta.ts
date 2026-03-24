import { Hono } from 'hono';
import type { MetaResponse } from '@opencara/shared';
import type { Env } from '../types.js';
import { SERVER_VERSION, MIN_CLI_VERSION } from '../version.js';

export function metaRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  /** GET /api/meta — public server metadata (no auth required) */
  app.get('/api/meta', (c) => {
    return c.json<MetaResponse>({
      server_version: SERVER_VERSION,
      min_cli_version: MIN_CLI_VERSION,
      features: [],
    });
  });

  return app;
}
