import type { D1Database } from './store/d1.js';
import type { DataStore } from './store/interface.js';
import type { Logger } from './logger.js';

/**
 * Minimal KVNamespace interface — subset of Cloudflare Workers KV API.
 * Defined locally so the server package compiles without @cloudflare/workers-types,
 * enabling the Node.js / VPS deployment path.
 */
export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(
    key: string,
    value: string,
    options?: { expirationTtl?: number; metadata?: unknown },
  ): Promise<void>;
  delete(key: string): Promise<void>;
  list(options: { prefix: string }): Promise<{ keys: Array<{ name: string; metadata?: unknown }> }>;
}

/** Environment bindings — used by both Cloudflare Workers and Node.js entry points. */
export interface Env {
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  /** Workers KV binding (optional — VPS mode uses D1/SQLite only). */
  TASK_STORE?: KVNamespace;
  /** D1 database binding (optional — preferred over KV when present). */
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
