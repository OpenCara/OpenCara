import type { DataStore } from './store/interface.js';
import type { Logger } from './logger.js';

/** Cloudflare Workers environment bindings */
export interface Env {
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  TASK_STORE: KVNamespace;
  /** Optional D1 binding — preferred over KV when present. */
  DB?: D1Database;
  WEB_URL: string;
  /** TTL in days for terminal tasks (default: 7). Set via wrangler.toml [vars]. */
  TASK_TTL_DAYS?: string;
}

/** Hono context variables (set per-request via middleware) */
export interface AppVariables {
  store: DataStore;
  logger: Logger;
  requestId: string;
}

/** Filter for querying tasks */
export interface TaskFilter {
  status?: string[];
  timeout_before?: number; // unix ms — find tasks that timed out
}
