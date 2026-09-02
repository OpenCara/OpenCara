import { sql, type SQL } from "drizzle-orm";
import type { Db } from "../db/client.js";

/**
 * How long to keep `trigger_skip` flow runs before pruning them.
 *
 * `trigger_skip` runs are the dominant flow_runs population on a busy instance:
 * every webhook the trigger node rejects (the default-hidden fan-out noise)
 * leaves one behind. They carry no steps or agent runs — the trigger bailed
 * before execution — so they're pure retention overhead. The kanban
 * implement-status query only ever looks back one hour at terminal rows, and
 * the Flow runs page hides `trigger_skip` entirely, so nothing in the product
 * reads them after the first hour; a week is generous headroom for debugging.
 */
export const DEFAULT_TRIGGER_SKIP_RETENTION_DAYS = 7;

/**
 * How long to keep platform events that nothing references.
 *
 * Every webhook delivery lands in `platform_events`, but only the few that a
 * trigger accepted are ever pointed at by a `flow_runs.trigger_event_id` /
 * `agent_runs.trigger_event_id`. The rest (bot comments, label churn, pushes
 * to branches no flow watches, and — after the trigger_skip prune — the
 * events behind those skipped runs) have two readers: the Activity feed,
 * which only shows the newest page, and the Azure DevOps webhook handler's
 * `previousPrDelivery` probe (routes/webhooksAzure.ts), which looks back
 * 90 days for the last `pull_request` delivery of the same PR to tell a
 * real push from a metadata edit. The default must stay >= that lookback,
 * or a PR quiet for longer than the retention window gets one extra review
 * (fail-open) when it next changes. Payloads average ~17kB, so on a busy
 * instance the unreferenced majority is still most of the table.
 */
export const DEFAULT_UNREFERENCED_EVENT_RETENTION_DAYS = 90;

/**
 * How long to keep housekeeping agent runs (`spec.kind` = 'internal:*',
 * e.g. worktree allocate / write-session / remove).
 *
 * They are hidden from every run list and the Activity feed; their only
 * value is debugging a recent worktree problem. Each row carries a ~16kB
 * spec plus its `agent_run_logs`, and on a busy instance they outnumber
 * real agent runs, so they dominate `agent_runs` growth.
 */
export const DEFAULT_INTERNAL_RUN_RETENTION_DAYS = 7;

/**
 * Rows deleted per statement. Every pooled connection runs with a 30s
 * `statement_timeout` (db/client.ts); one unbounded DELETE over a first-run
 * backlog of tens of thousands of TOASTed rows (plus cascading
 * `agent_run_logs`) could trip it, roll back in full, and be retried
 * unchanged every day without ever converging. Fixed-size batches keep each
 * statement well inside the timeout and make partial progress durable.
 */
export const PRUNE_BATCH_SIZE = 1000;

/**
 * Cutoff instant: rows created before this are eligible for pruning.
 *
 * Bound into the batch statements as an ISO string with an explicit
 * `::timestamptz` cast: the raw `sql` template path hands parameters to
 * postgres-js without column type info, and a bare `Date` there fails
 * with ERR_INVALID_ARG_TYPE (seen on the v0.124.0 boot prune).
 */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
}

/**
 * Run `batch(limit)` — a DELETE that returns one row `{ n }` with the count it
 * removed — until a batch comes back short. Returns the total removed.
 */
export async function deleteInBatches(
  db: Db,
  batch: (limit: number) => SQL,
  batchSize: number = PRUNE_BATCH_SIZE,
): Promise<number> {
  let total = 0;
  for (;;) {
    const rows = await db.execute<{ n: number | string }>(batch(batchSize));
    const n = Number(rows[0]?.n ?? 0);
    total += n;
    if (n < batchSize) return total;
  }
}

/**
 * Delete `cancelled` + `trigger_skip` flow runs older than the retention
 * window. Returns the number of rows removed.
 *
 * Scoped narrowly on purpose: only `cancel_reason = 'trigger_skip'` is touched,
 * so `abandoned` (reaper-restored) runs and every succeeded/failed run are kept
 * for history regardless of age. These rows have no dependent steps/agent_runs,
 * so the delete doesn't cascade into meaningful work even when clearing a large
 * first-run backlog (OpenCara#146 left ~14k of them).
 */
export function triggerSkipFlowRunsBatch(cutoff: Date, limit: number): SQL {
  return sql`
    WITH victims AS (
      SELECT id FROM flow_runs
      WHERE status = 'cancelled'
        AND cancel_reason = 'trigger_skip'
        AND created_at < ${cutoff.toISOString()}::timestamptz
      LIMIT ${limit}
    ), deleted AS (
      DELETE FROM flow_runs WHERE id IN (SELECT id FROM victims) RETURNING 1
    )
    SELECT count(*)::int AS n FROM deleted`;
}

export async function pruneTriggerSkipFlowRuns(
  db: Db,
  retentionDays: number = DEFAULT_TRIGGER_SKIP_RETENTION_DAYS,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = retentionCutoff(now, retentionDays);
  return deleteInBatches(db, (limit) => triggerSkipFlowRunsBatch(cutoff, limit));
}

/**
 * Delete platform events older than the retention window that no flow run
 * or agent run references. Returns the number of rows removed.
 *
 * The NOT EXISTS guards (rather than relying on the FK) are what make this
 * safe: an event still pointed at by a run is history for that run's detail
 * page and its Activity entries, so it stays regardless of age.
 */
export function unreferencedPlatformEventsBatch(cutoff: Date, limit: number): SQL {
  return sql`
    WITH victims AS (
      SELECT e.id FROM platform_events e
      WHERE e.received_at < ${cutoff.toISOString()}::timestamptz
        AND NOT EXISTS (SELECT 1 FROM flow_runs fr WHERE fr.trigger_event_id = e.id)
        AND NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.trigger_event_id = e.id)
      LIMIT ${limit}
    ), deleted AS (
      DELETE FROM platform_events WHERE id IN (SELECT id FROM victims) RETURNING 1
    )
    SELECT count(*)::int AS n FROM deleted`;
}

export async function pruneUnreferencedPlatformEvents(
  db: Db,
  retentionDays: number = DEFAULT_UNREFERENCED_EVENT_RETENTION_DAYS,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = retentionCutoff(now, retentionDays);
  return deleteInBatches(db, (limit) => unreferencedPlatformEventsBatch(cutoff, limit));
}

/**
 * Delete housekeeping agent runs (`spec.kind` LIKE 'internal:%') older than
 * the retention window. Their `agent_run_logs` cascade. Returns the number
 * of rows removed.
 *
 * Only terminal rows go: a still-running internal job is owned by a live
 * flow step and must not vanish under it, however old its created_at.
 */
export function internalAgentRunsBatch(cutoff: Date, limit: number): SQL {
  return sql`
    WITH victims AS (
      SELECT id FROM agent_runs
      WHERE created_at < ${cutoff.toISOString()}::timestamptz
        AND spec->>'kind' LIKE 'internal:%'
        AND status::text IN ('succeeded', 'failed', 'cancelled')
      LIMIT ${limit}
    ), deleted AS (
      DELETE FROM agent_runs WHERE id IN (SELECT id FROM victims) RETURNING 1
    )
    SELECT count(*)::int AS n FROM deleted`;
}

export async function pruneInternalAgentRuns(
  db: Db,
  retentionDays: number = DEFAULT_INTERNAL_RUN_RETENTION_DAYS,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = retentionCutoff(now, retentionDays);
  return deleteInBatches(db, (limit) => internalAgentRunsBatch(cutoff, limit));
}
