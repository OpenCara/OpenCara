import { and, eq, lt, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentRuns, flowRuns, platformEvents } from "../db/schema.js";

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

/** Cutoff instant: rows created before this are eligible for pruning. */
export function retentionCutoff(now: Date, retentionDays: number): Date {
  return new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
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
export async function pruneTriggerSkipFlowRuns(
  db: Db,
  retentionDays: number = DEFAULT_TRIGGER_SKIP_RETENTION_DAYS,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = retentionCutoff(now, retentionDays);
  const deleted = await db
    .delete(flowRuns)
    .where(
      and(
        eq(flowRuns.status, "cancelled"),
        eq(flowRuns.cancelReason, "trigger_skip"),
        lt(flowRuns.createdAt, cutoff),
      ),
    )
    .returning({ id: flowRuns.id });
  return deleted.length;
}

/**
 * How long to keep platform events that nothing references.
 *
 * Every webhook delivery lands in `platform_events`, but only the few that a
 * trigger accepted are ever pointed at by a `flow_runs.trigger_event_id` /
 * `agent_runs.trigger_event_id`. The rest (bot comments, label churn, pushes
 * to branches no flow watches, and — after the trigger_skip prune — the
 * events behind those skipped runs) are read by exactly one thing: the
 * Activity feed, which only ever shows the newest page. Payloads average
 * ~17kB, so on a busy instance the unreferenced majority is most of the
 * table's footprint.
 */
export const DEFAULT_UNREFERENCED_EVENT_RETENTION_DAYS = 30;

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
 * Delete platform events older than the retention window that no flow run
 * or agent run references. Returns the number of rows removed.
 *
 * The NOT EXISTS guards (rather than relying on the FK) are what make this
 * safe: an event still pointed at by a run is history for that run's detail
 * page and its Activity entries, so it stays regardless of age.
 */
export async function pruneUnreferencedPlatformEvents(
  db: Db,
  retentionDays: number = DEFAULT_UNREFERENCED_EVENT_RETENTION_DAYS,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = retentionCutoff(now, retentionDays);
  const deleted = await db
    .delete(platformEvents)
    .where(
      and(
        lt(platformEvents.receivedAt, cutoff),
        sql`NOT EXISTS (SELECT 1 FROM flow_runs fr WHERE fr.trigger_event_id = ${platformEvents.id})`,
        sql`NOT EXISTS (SELECT 1 FROM agent_runs r WHERE r.trigger_event_id = ${platformEvents.id})`,
      ),
    )
    .returning({ id: platformEvents.id });
  return deleted.length;
}

/**
 * Delete housekeeping agent runs (`spec.kind` LIKE 'internal:%') older than
 * the retention window. Their `agent_run_logs` cascade. Returns the number
 * of rows removed.
 *
 * Only terminal rows go: a still-running internal job is owned by a live
 * flow step and must not vanish under it, however old its created_at.
 */
export async function pruneInternalAgentRuns(
  db: Db,
  retentionDays: number = DEFAULT_INTERNAL_RUN_RETENTION_DAYS,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = retentionCutoff(now, retentionDays);
  const deleted = await db
    .delete(agentRuns)
    .where(
      and(
        lt(agentRuns.createdAt, cutoff),
        sql`${agentRuns.spec}->>'kind' LIKE 'internal:%'`,
        sql`${agentRuns.status}::text IN ('succeeded', 'failed', 'cancelled')`,
      ),
    )
    .returning({ id: agentRuns.id });
  return deleted.length;
}
