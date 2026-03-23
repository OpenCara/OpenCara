/**
 * Node.js entry point for VPS / self-hosted deployments.
 *
 * Uses @hono/node-server to serve the same Hono app that runs on CF Workers,
 * with a SQLite database (via better-sqlite3) instead of Cloudflare D1/KV.
 *
 * Environment variables:
 *   PORT                    — HTTP port (default: 3000)
 *   DATABASE_PATH           — SQLite database file path (default: ./data/opencara.db)
 *   DEV_MODE                — Set to 'true' to skip GitHub credentials and mount test routes
 *   GITHUB_WEBHOOK_SECRET   — GitHub App webhook secret
 *   GITHUB_APP_ID           — GitHub App ID (optional when DEV_MODE=true)
 *   GITHUB_APP_PRIVATE_KEY  — GitHub App private key, PEM (optional when DEV_MODE=true)
 *   WEB_URL                 — Public URL for the server (default: http://localhost:3000)
 *   TASK_TTL_DAYS           — TTL in days for terminal tasks (default: 7)
 *   API_KEYS                — Comma-separated valid API keys (optional; open mode if unset)
 */
import { serve } from '@hono/node-server';
import cron from 'node-cron';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { SqliteD1Adapter } from './adapters/sqlite.js';
import { D1DataStore } from './store/d1.js';
import { buildApp, parseTtlDays } from './index.js';
import { checkTimeouts } from './routes/tasks.js';
import { testRoutes } from './routes/test.js';
import { createLogger } from './logger.js';
import { RealGitHubService, NoOpGitHubService } from './github/service.js';
import type { GitHubService } from './github/service.js';
import type { Env } from './types.js';

const logger = createLogger();

// ── Environment ─────────────────────────────────────────────────────

const DEV_MODE = process.env.DEV_MODE === 'true';
const PORT = parseInt(process.env.PORT ?? '3000', 10);
const DATABASE_PATH = process.env.DATABASE_PATH ?? './data/opencara.db';

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    logger.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

const GITHUB_WEBHOOK_SECRET = DEV_MODE
  ? (process.env.GITHUB_WEBHOOK_SECRET ?? 'dev-secret')
  : requiredEnv('GITHUB_WEBHOOK_SECRET');
const GITHUB_APP_ID = DEV_MODE
  ? (process.env.GITHUB_APP_ID ?? 'dev-app-id')
  : requiredEnv('GITHUB_APP_ID');
const GITHUB_APP_PRIVATE_KEY = DEV_MODE
  ? (process.env.GITHUB_APP_PRIVATE_KEY ?? 'dev-private-key')
  : requiredEnv('GITHUB_APP_PRIVATE_KEY');
const WEB_URL = process.env.WEB_URL ?? `http://localhost:${PORT}`;
const TASK_TTL_DAYS = process.env.TASK_TTL_DAYS;
const API_KEYS = process.env.API_KEYS;

// ── GitHub service ──────────────────────────────────────────────────

const githubService: GitHubService = DEV_MODE
  ? new NoOpGitHubService(logger)
  : new RealGitHubService(GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, logger);

// ── Database setup ──────────────────────────────────────────────────

const dbDir = path.dirname(path.resolve(DATABASE_PATH));
try {
  fs.mkdirSync(dbDir, { recursive: true });
} catch (err) {
  logger.error('Failed to create database directory', {
    path: dbDir,
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
}

const sqliteAdapter = new SqliteD1Adapter(DATABASE_PATH);

// ── Migration runner ────────────────────────────────────────────────

function runMigrations(): void {
  const migrationsDir = path.resolve(import.meta.dirname, '../migrations');
  if (!fs.existsSync(migrationsDir)) {
    logger.warn('No migrations directory found', { path: migrationsDir });
    return;
  }

  const rawDb = sqliteAdapter.getRawDb();

  rawDb.exec(`CREATE TABLE IF NOT EXISTS _migrations (
    name TEXT PRIMARY KEY,
    applied_at INTEGER NOT NULL
  )`);

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  for (const file of files) {
    const existing = rawDb.prepare('SELECT 1 FROM _migrations WHERE name = ?').get(file);
    if (existing) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    try {
      rawDb.exec(sql);
    } catch (err) {
      logger.error('Migration failed', {
        file,
        error: err instanceof Error ? err.message : String(err),
      });
      process.exit(1);
    }

    rawDb.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)').run(file, Date.now());

    logger.info('Applied migration', { file });
  }
}

// ── Build app ───────────────────────────────────────────────────────

const nodeEnv: Env = {
  GITHUB_WEBHOOK_SECRET,
  GITHUB_APP_ID,
  GITHUB_APP_PRIVATE_KEY,
  DB: sqliteAdapter,
  WEB_URL,
  TASK_TTL_DAYS,
  API_KEYS,
};

const ttlDays = parseTtlDays(nodeEnv);
const store = new D1DataStore(sqliteAdapter, ttlDays);

const app = buildApp(
  () => store,
  () => githubService,
);

// Inject nodeEnv into c.env so route handlers can access env vars
app.use('*', async (c, next) => {
  Object.assign(c.env, nodeEnv);
  await next();
});

// Mount test routes in dev mode
if (DEV_MODE) {
  app.route('/', testRoutes());
  logger.info('Dev mode enabled — test routes mounted at /test/*');
}

// ── Start ───────────────────────────────────────────────────────────

runMigrations();

const server = serve({ fetch: app.fetch, port: PORT }, () => {
  logger.info('OpenCara server started', {
    port: PORT,
    database: DATABASE_PATH,
    devMode: DEV_MODE,
  });
});

// ── Scheduled tasks (replaces CF Cron Triggers) ─────────────────────

let cronRunning = false;

cron.schedule('* * * * *', async () => {
  if (cronRunning) return;
  cronRunning = true;
  try {
    await store.setTimeoutLastCheck(Date.now());
    await checkTimeouts(store, githubService, logger);
  } catch (err) {
    logger.error('Scheduled timeout check failed', {
      action: 'check_timeouts',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    const deleted = await store.cleanupTerminalTasks();
    if (deleted > 0) {
      logger.info('Cleaned up terminal tasks', { action: 'cleanup_terminal', deleted });
    }
  } catch (err) {
    logger.error('Scheduled terminal cleanup failed', {
      action: 'cleanup_terminal',
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    cronRunning = false;
  }
});

// ── Graceful shutdown ───────────────────────────────────────────────

let shuttingDown = false;

function shutdown(): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down...');

  // Give in-flight requests up to 10 seconds to complete.
  const forceExit = setTimeout(() => {
    logger.warn('Forcing exit after timeout');
    sqliteAdapter.close();
    process.exit(1);
  }, 10_000);
  forceExit.unref();

  server.close(() => {
    sqliteAdapter.close();
    logger.info('Shutdown complete');
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
