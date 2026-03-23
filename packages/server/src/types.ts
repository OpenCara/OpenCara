import type { D1Database } from './store/d1.js';
import type { DataStore } from './store/interface.js';
import type { GitHubService } from './github/service.js';
import type { Logger } from './logger.js';

/** Environment bindings — used by both Cloudflare Workers and Node.js entry points. */
export interface Env {
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  /** D1 database binding (optional — preferred; falls back to MemoryDataStore). */
  DB?: D1Database;
  WEB_URL: string;
  /** TTL in days for terminal tasks (default: 7). Set via wrangler.toml [vars]. */
  TASK_TTL_DAYS?: string;
}

/** Hono context variables (set per-request via middleware) */
export interface AppVariables {
  store: DataStore;
  github: GitHubService;
  logger: Logger;
  requestId: string;
}

/** Filter for querying tasks */
export interface TaskFilter {
  status?: string[];
  timeout_before?: number; // unix ms — find tasks that timed out
}
