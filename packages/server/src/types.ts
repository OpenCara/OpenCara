import type { TaskStore } from './store/interface.js';

/** Cloudflare Workers environment bindings */
export interface Env {
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  TASK_STORE: KVNamespace;
  WEB_URL: string;
}

/** Hono context variables (set per-request via middleware) */
export interface AppVariables {
  store: TaskStore;
}

/** Filter for querying tasks */
export interface TaskFilter {
  status?: string[];
  timeout_before?: number; // unix ms — find tasks that timed out
}
