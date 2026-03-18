export interface Env {
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_APP_ID: string;
  GITHUB_APP_PRIVATE_KEY: string;
  /** GitHub App client ID — used for web OAuth */
  GITHUB_CLIENT_ID: string;
  /** GitHub App client secret — used for web OAuth */
  GITHUB_CLIENT_SECRET: string;
  /** OAuth App client ID — used for CLI device flow */
  GITHUB_CLI_CLIENT_ID: string;
  /** OAuth App client secret — used for CLI device flow */
  GITHUB_CLI_CLIENT_SECRET: string;
  SUPABASE_URL: string;
  SUPABASE_SERVICE_ROLE_KEY: string;
  AGENT_CONNECTION: DurableObjectNamespace;
  TASK_TIMEOUT: DurableObjectNamespace;
  RATE_LIMIT_KV: KVNamespace;
  WEB_URL: string;
  WORKER_URL: string;
}
