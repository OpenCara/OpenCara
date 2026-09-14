import { drizzle } from "drizzle-orm/postgres-js";
import postgres, { type Options, type Sql } from "postgres";
import * as schema from "./schema.js";

export type Db = ReturnType<typeof drizzle<typeof schema>>;

export interface DbHandle {
  db: Db;
  pg: Sql;
}

export function intFromEnv(
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
 *   max               Size of the QUERY connection pool. It must stay strictly
 *                     below the Supabase session pooler's per-role ceiling
 *                     (Supavisor `pool_size`, 15 on this project) because
 *                     postgres-js opens a SEPARATE, dedicated LISTEN connection
 *                     (one shared singleton for all `pg.listen` channels, see
 *                     postgres-js `listen.sql`) that is NOT counted in `max`.
 *                     So real peak = max + 1 (listen) + brief overlap while a
 *                     `max_lifetime`-recycled connection is replaced. With the
 *                     old default of 15, that peak was 16 > 15 and the pooler
 *                     rejected the surplus with EMAXCONNSESSION the moment the
 *                     query pool saturated — which crashed the orchestrator via
 *                     an unguarded SSE poll (2026-06-07). 12 leaves headroom for
 *                     the listen connection and recycle overlap. Override with
 *                     DB_POOL_MAX (raise only if the Supabase pool_size is
 *                     raised to match).
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
/**
 * SSL is only worth forcing on connections that leave the host. Loopback,
 * RFC-1918 addresses, and dotless hostnames (Docker/compose service names
 * like `db` or `postgres` — the production topology after the #245 local-PG
 * move) are all link-local/private, where `ssl: require` would just break
 * against a stock postgres image. `DB_SSL=require|disable` overrides for
 * exotic cases (e.g. an internal CA on a dotted LAN name).
 */
function sslFor(databaseUrl: string, env: NodeJS.ProcessEnv): Options<Record<string, never>>["ssl"] {
  const override = env.DB_SSL;
  if (override === "require") return "require";
  if (override === "disable") return false;
  let host = "";
  try {
    host = new URL(databaseUrl).hostname;
  } catch {
    return "require"; // unparseable — fail closed toward encryption
  }
  const isLocal =
    host === "localhost" ||
    host === "[::1]" ||
    host === "::1" ||
    !host.includes(".") || // bare service name (docker network, /etc/hosts)
    /^(127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host);
  return isLocal ? false : "require";
}

export function poolOptions(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): Options<Record<string, never>> {
  const statementTimeoutMs = intFromEnv(env, "DB_STATEMENT_TIMEOUT_MS", 30_000);
  return {
    max: intFromEnv(env, "DB_POOL_MAX", 12),
    ssl: sslFor(databaseUrl, env),
    connect_timeout: intFromEnv(env, "DB_CONNECT_TIMEOUT_SEC", 10),
    max_lifetime: intFromEnv(env, "DB_MAX_LIFETIME_SEC", 60 * 30),
    idle_timeout: intFromEnv(env, "DB_IDLE_TIMEOUT_SEC", 60),
    // Passed through to the server at connection startup. postgres accepts a
    // bare integer as milliseconds. application_name lets the pool monitor
    // (db/poolMonitor.ts) pick OUR connections out of pg_stat_activity —
    // through the shared Supabase pooler, "everyone's" sessions are
    // indistinguishable without it.
    connection: {
      statement_timeout: statementTimeoutMs,
      application_name: "opencara-server",
    },
  };
}

export function createDb(
  databaseUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): DbHandle {
  const pg = postgres(databaseUrl, poolOptions(databaseUrl, env));
  return { db: drizzle(pg, { schema }), pg };
}
