import { and, eq, lt } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { flowRuns } from "../db/schema.js";

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
