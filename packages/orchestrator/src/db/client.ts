import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Options, type Sql } from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: Db;
  pg: Sql;
}

function intFromEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
): number {
  const raw = env[key];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Build the postgres-js pool options. Pure (env in, options out) so the
 * tuning can be unit-tested without opening a connection.
 *
 * Why these knobs exist — opencara.com wedged for ~90s on every authenticated
 * request (OpenCara#146): a kanban-SSE query flood kept all pool connections
 * busy, so `loadSession` (run by the auth middleware on EVERY request) sat in
 * postgres-js's acquire queue until a slot freed. The flood itself is fixed in
 * #149 (project-scoped, coalesced rebuilds) + the new flow_runs index/prune;
 * these options are defense-in-depth so a future hot path degrades gracefully
 * instead of taking the whole site down:
 *
 *   max               More headroom before queries start queueing. Stays well
 *                     under Postgres `max_connections` (shared with the pooler
 *                     and other clients). Override with DB_POOL_MAX.
 *   connect_timeout   Fail a connection attempt fast rather than hanging.
 *   max_lifetime      Recycle connections periodically so a long-lived process
 *                     never accumulates permanently-stale pooler connections.
 *   idle_timeout      Return idle connections to the pooler so we don't pin
 *                     server-side slots during quiet periods.
 *   statement_timeout Server-side cap (ms) on any single query, so a slow or
 *                     accidental table-scan can't pin a pool connection for
 *                     minutes. NOTE: this also applies to the boot-time
 *                     migration connection (index/DDL builds must finish within
 *                     it — fine for current data sizes; bump DB_STATEMENT_TIMEOUT_MS
 *                     if a future migration needs longer).
 */
export function poolOptions(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Options<Record<string, never>> {
  const isLocal = /@(localhost|127\.0\.0\.1|\[::1])\b/.test(databaseUrl);
  const statementTimeoutMs = intFromEnv(env, "DB_STATEMENT_TIMEOUT_MS", 30_000);
  return {
    max: intFromEnv(env, "DB_POOL_MAX", 15),
    ssl: isLocal ? false : "require",
    connect_timeout: intFromEnv(env, "DB_CONNECT_TIMEOUT_SEC", 10),
    max_lifetime: intFromEnv(env, "DB_MAX_LIFETIME_SEC", 60 * 30),
    idle_timeout: intFromEnv(env, "DB_IDLE_TIMEOUT_SEC", 60),
    // Passed through to the server at connection startup. postgres accepts a
    // bare integer as milliseconds.
    connection: { statement_timeout: statementTimeoutMs },
  };
}

export function createDb(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): DbHandle {
  const pg = postgres(databaseUrl, poolOptions(databaseUrl, env));
  return { db: drizzle(pg, { schema }), pg };
}
