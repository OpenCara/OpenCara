import { execSync } from 'node:child_process';

export type GithubAuthMethod = 'env' | 'gh-cli' | 'config' | 'none';

export interface GithubAuthResult {
  token: string | null;
  method: GithubAuthMethod;
}

/**
 * Extract GitHub token from `gh auth token`.
 * Returns null if gh is not installed, not authenticated, or times out.
 */
export function getGhCliToken(): string | null {
  try {
    const result = execSync('gh auth token', {
      timeout: 5000,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const token = result.trim();
    return token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * Resolve GitHub token using the 4-tier fallback chain:
 * 1. GITHUB_TOKEN env var — CI/automation override
 * 2. gh auth token — local dev UX via gh CLI
 * 3. config token — from ~/.opencara/config.yml (per-agent or global)
 * 4. No auth — public repos only
 *
 * Called once at agent startup. The resolved token is reused for all operations.
 */
export function resolveGithubToken(
  configToken?: string | null,
  deps: { getEnv?: (key: string) => string | undefined; getGhToken?: () => string | null } = {},
): GithubAuthResult {
  const getEnv = deps.getEnv ?? ((key: string) => process.env[key]);
  const getGhToken = deps.getGhToken ?? getGhCliToken;

  // Tier 1: GITHUB_TOKEN env var
  const envToken = getEnv('GITHUB_TOKEN');
  if (envToken) {
    return { token: envToken, method: 'env' };
  }

  // Tier 2: gh auth token
  const ghToken = getGhToken();
  if (ghToken) {
    return { token: ghToken, method: 'gh-cli' };
  }

  // Tier 3: config file token
  if (configToken) {
    return { token: configToken, method: 'config' };
  }

  // Tier 4: no auth
  return { token: null, method: 'none' };
}

const AUTH_LOG_MESSAGES: Record<GithubAuthMethod, string> = {
  env: 'GitHub auth: using GITHUB_TOKEN env var',
  'gh-cli': 'GitHub auth: using gh CLI token',
  config: 'GitHub auth: using config github_token',
  none: 'GitHub auth: none (public repos only)',
};

/**
 * Log which auth method was resolved. Called once at startup.
 */
export function logAuthMethod(method: GithubAuthMethod, log: (msg: string) => void): void {
  log(AUTH_LOG_MESSAGES[method]);
}
