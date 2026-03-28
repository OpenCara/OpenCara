import type { VerifiedIdentity } from '@opencara/shared';
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
  /** Comma-separated list of valid API keys. When set, task endpoints require Bearer auth. */
  API_KEYS?: string;
  /** GitHub App client ID — used for OAuth token verification and Device Flow proxy. */
  GITHUB_CLIENT_ID?: string;
  /** GitHub App client secret — used for OAuth token verification and Device Flow proxy (never exposed to clients). */
  GITHUB_CLIENT_SECRET?: string;
}

/** Hono context variables (set per-request via middleware) */
export interface AppVariables {
  store: DataStore;
  github: GitHubService;
  logger: Logger;
  requestId: string;
  /** Verified identity from OAuth token (set by oauth middleware) */
  verifiedIdentity?: VerifiedIdentity;
}

/** Filter for querying tasks */
export interface TaskFilter {
  status?: string[];
  timeout_before?: number; // unix ms — find tasks that timed out
}
