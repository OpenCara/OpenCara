import type { Sql } from "postgres";

/**
 * Periodic pool-utilization sampler.
 *
 * postgres-js exposes no public pool metrics — its acquire queue lives in a
 * module closure. What it CAN'T hide is the server-side view: every pooled
 * connection appears in pg_stat_activity (tagged with the application_name
 * set in client.ts). Sampling that view gives us the signal that was missing
 * during the OpenCara#245 503 bursts: how many of our `max` connections are
 * actually busy, and which queries are pinning them.
 *
 * Design: one small query every `intervalMs`, results logged ONLY when they
 * cross a threshold (active conns >= warnActiveConns, or any query running
 * longer than warnQueryMs). Quiet DB ⇒ quiet logs; a saturating pool ⇒ a
 * warning naming the longest-running query so the culprit is greppable
 * instead of inferred. The timer is unref'd so it never holds the process.
 *
 * The sampler's own query borrows one pooled connection — at warnActiveConns
 * = 8 / max = 12 that leaves headroom, and the sample is exactly the load we
 * want measured anyway.
 */

const APPLICATION_NAME = "opencara-server";

export interface PoolMonitorOptions {
  intervalMs?: number; // default 30s; 0 disables the monitor
  warnActiveConns?: number; // log when our active conns reach this (default 8)
  warnQueryMs?: number; // log when one of our queries exceeds this (default 2000)
  now?: () => number;
  log?: (msg: string) => void;
}

interface SampleRow {
  active: number;
  idle: number;
  idle_in_tx: number;
  longest_ms: number | null;
  longest_query: string | null;
}

const SAMPLE_SQL = `
  SELECT
    count(*) FILTER (WHERE state = 'active')::int              AS active,
    count(*) FILTER (WHERE state = 'idle')::int                AS idle,
    count(*) FILTER (WHERE state = 'idle in transaction')::int AS idle_in_tx,
    (SELECT round(extract(epoch FROM now() - query_start) * 1000)::int
     FROM pg_stat_activity
     WHERE application_name = '${APPLICATION_NAME}'
       AND state = 'active' AND pid <> pg_backend_pid()
     ORDER BY query_start ASC LIMIT 1)                          AS longest_ms,
    (SELECT left(regexp_replace(query, '\\s+', ' ', 'g'), 160)
     FROM pg_stat_activity
     WHERE application_name = '${APPLICATION_NAME}'
       AND state = 'active' AND pid <> pg_backend_pid()
     ORDER BY query_start ASC LIMIT 1)                          AS longest_query
  FROM pg_stat_activity
  WHERE application_name = '${APPLICATION_NAME}'
    AND pid <> pg_backend_pid()`;

/**
 * Runs one sample against `pg` and returns a log line when thresholds are
 * crossed (null when quiet). Pure-ish and exported for tests: the SQL lives
 * in SAMPLE_SQL so a fake Sql can script the response row.
 */
export function poolMonitorMessage(
  row: SampleRow,
  opts: Required<Pick<PoolMonitorOptions, "warnActiveConns" | "warnQueryMs">>,
): string | null {
  const busy = row.active >= opts.warnActiveConns;
  const slow = row.longest_ms !== null && row.longest_ms >= opts.warnQueryMs;
  if (!busy && !slow) return null;
  const parts = [
    `active=${row.active}`,
    `idle=${row.idle}`,
    `idle_in_tx=${row.idle_in_tx}`,
  ];
  if (slow) {
    parts.push(`longest_query_ms=${row.longest_ms}`, `query="${row.longest_query}"`);
  }
  return `[db-pool] utilisation high: ${parts.join(" ")}`;
}

export function startPoolMonitor(
  pg: Sql,
  opts: PoolMonitorOptions = {},
): NodeJS.Timeout | null {
  const intervalMs = opts.intervalMs ?? 30_000;
  if (intervalMs <= 0) return null;
  const warnActiveConns = opts.warnActiveConns ?? 8;
  const warnQueryMs = opts.warnQueryMs ?? 2_000;
  const log = opts.log ?? ((m: string) => console.warn(m));

  const tick = async () => {
    try {
      const rows = await pg.unsafe<SampleRow[]>(SAMPLE_SQL);
      const row = rows[0];
      if (!row) return;
      const msg = poolMonitorMessage(row, { warnActiveConns, warnQueryMs });
      if (msg) log(msg);
    } catch (err) {
      // Never let telemetry take the server down — a failed sample is
      // itself a signal worth one log line, then we keep going.
      console.error("[db-pool] sample failed", err);
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  return timer;
}
