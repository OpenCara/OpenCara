import { Command } from 'commander';
import pc from 'picocolors';
import { icons } from '../logger.js';
import { loadAuth, saveAuth, deleteAuth, login, getAuthFilePath, AuthError } from '../auth.js';
import type { StoredAuth, LoginDeps } from '../auth.js';
import { loadConfig } from '../config.js';

/** Dependencies for auth commands — allows injection for testing. */
export interface AuthCommandDeps {
  loadAuthFn?: () => StoredAuth | null;
  deleteAuthFn?: () => void;
  loginFn?: (platformUrl: string, deps: LoginDeps) => Promise<StoredAuth>;
  saveAuthFn?: (auth: StoredAuth) => void;
  loadConfigFn?: typeof loadConfig;
  getAuthFilePathFn?: () => string;
  log?: (msg: string) => void;
  logError?: (msg: string) => void;
  nowFn?: () => number;
  confirmFn?: (prompt: string) => Promise<boolean>;
}

/** Default interactive confirm — reads from stdin. */
export async function defaultConfirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }
  const { createInterface } = await import('node:readline');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    let answered = false;
    rl.once('close', () => {
      if (!answered) resolve(false);
    });
    rl.question(`${prompt} (y/N) `, (answer) => {
      answered = true;
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

/** Format a Unix ms timestamp as a human-readable date string. */
function formatExpiry(expiresAt: number): string {
  const d = new Date(expiresAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/** Format time remaining until expiry as a human-readable string. */
function formatTimeRemaining(ms: number): string {
  if (ms <= 0) return 'expired';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) return `in ${hours} hour${hours === 1 ? '' : 's'}`;
  if (minutes > 0) return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  return 'in less than a minute';
}

/** Execute `opencara auth login`. */
export async function runLogin(deps: AuthCommandDeps = {}): Promise<void> {
  const loadAuthFn = deps.loadAuthFn ?? loadAuth;
  const loginFn = deps.loginFn ?? login;
  const loadConfigFn = deps.loadConfigFn ?? loadConfig;
  const getAuthFilePathFn = deps.getAuthFilePathFn ?? getAuthFilePath;
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const confirmFn = deps.confirmFn ?? defaultConfirm;

  // Check if already authenticated
  const existing = loadAuthFn();
  if (existing) {
    const confirmed = await confirmFn(
      `Already logged in as ${pc.bold(`@${existing.github_username}`)}. Re-authenticate?`,
    );
    if (!confirmed) {
      log('Login cancelled.');
      return;
    }
  }

  const config = loadConfigFn();

  try {
    // Suppress the generic "Authenticated as" from login() since we log a richer version below
    const loginLog = (msg: string) => {
      if (!msg.includes('Authenticated as')) log(msg);
    };
    const auth = await loginFn(config.platformUrl, {
      log: loginLog,
      saveAuthFn: deps.saveAuthFn,
    });
    log(
      `${icons.success} Authenticated as ${pc.bold(`@${auth.github_username}`)} (ID: ${auth.github_user_id})`,
    );
    log(`Token saved to ${pc.dim(getAuthFilePathFn())}`);
  } catch (err) {
    if (err instanceof AuthError) {
      logError(`${icons.error} ${err.message}`);
      process.exitCode = 1;
      return;
    }
    throw err;
  }
}

/** Execute `opencara auth status`. */
export function runStatus(deps: AuthCommandDeps = {}): void {
  const loadAuthFn = deps.loadAuthFn ?? loadAuth;
  const getAuthFilePathFn = deps.getAuthFilePathFn ?? getAuthFilePath;
  const log = deps.log ?? console.log;
  const nowFn = deps.nowFn ?? Date.now;

  const auth = loadAuthFn();

  if (!auth) {
    log(`${icons.error} Not authenticated`);
    log(`  Run: ${pc.cyan('opencara auth login')}`);
    process.exitCode = 1;
    return;
  }

  const now = nowFn();
  // expires_at is absent for OAuth App tokens that never expire
  const expired = auth.expires_at !== undefined && auth.expires_at <= now;

  if (expired) {
    log(
      `${icons.warn} Token expired for ${pc.bold(`@${auth.github_username}`)} (ID: ${auth.github_user_id})`,
    );
    log(`  Token expired: ${formatExpiry(auth.expires_at!)}`);
    log(`  Auth file: ${pc.dim(getAuthFilePathFn())}`);
    log(`  Run: ${pc.cyan('opencara auth login')} to re-authenticate`);
    process.exitCode = 1;
    return;
  }

  log(
    `${icons.success} Authenticated as ${pc.bold(`@${auth.github_username}`)} (ID: ${auth.github_user_id})`,
  );
  if (auth.expires_at !== undefined) {
    const remaining = auth.expires_at - now;
    log(`  Token expires: ${formatExpiry(auth.expires_at)} (${formatTimeRemaining(remaining)})`);
  } else {
    log(`  Token expires: never (OAuth App token)`);
  }
  log(`  Auth file: ${pc.dim(getAuthFilePathFn())}`);
}

/** Execute `opencara auth logout`. */
export function runLogout(deps: AuthCommandDeps = {}): void {
  const loadAuthFn = deps.loadAuthFn ?? loadAuth;
  const deleteAuthFn = deps.deleteAuthFn ?? deleteAuth;
  const getAuthFilePathFn = deps.getAuthFilePathFn ?? getAuthFilePath;
  const log = deps.log ?? console.log;

  const auth = loadAuthFn();
  if (!auth) {
    log('Not logged in.');
    return;
  }

  deleteAuthFn();
  log(`Logged out. Token removed from ${pc.dim(getAuthFilePathFn())}`);
}

/** Build config-aware deps that thread auth_file from config.toml. */
function configAwareDeps(): AuthCommandDeps {
  const config = loadConfig();
  return {
    loadAuthFn: () => loadAuth(config.authFile),
    deleteAuthFn: () => deleteAuth(config.authFile),
    saveAuthFn: (auth: StoredAuth) => saveAuth(auth, config.authFile),
    loadConfigFn: () => config,
    getAuthFilePathFn: () => getAuthFilePath(config.authFile),
  };
}

/** Create the `auth` command group with login/status/logout subcommands. */
export function authCommand(): Command {
  const auth = new Command('auth').description('Manage authentication');

  auth
    .command('login')
    .description('Authenticate via GitHub Device Flow')
    .action(async () => {
      await runLogin(configAwareDeps());
    });

  auth
    .command('status')
    .description('Show current authentication status')
    .action(() => {
      runStatus(configAwareDeps());
    });

  auth
    .command('logout')
    .description('Remove stored authentication token')
    .action(() => {
      runLogout(configAwareDeps());
    });

  return auth;
}
