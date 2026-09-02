/**
 * Cancel a whole flow run: guarded status flip, in-flight agent runs killed
 * on their devices, SSE listeners woken. Shared by the UI cancel endpoint and
 * the engine's event-driven pre-emption (flows/preempt.ts).
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Sql } from "postgres";
import type { Db } from "../db/client.js";
import { flowRuns } from "../db/schema.js";
import type { AgentDispatcher } from "../dispatch/dispatcher.js";
import { cancelFlowRunAgents, type WireCancelReason } from "./cancelAgents.js";
import { FLOW_RUNS_CHANNEL, serializeFlowRunsNotify } from "./notify.js";

export interface CancelFlowRunDeps {
  db: Db;
  pg: Sql;
  dispatcher?: AgentDispatcher;
}

export interface CancelFlowRunResult {
  /** False when the run had already reached a terminal state. */
  cancelled: boolean;
  signalled: number;
}

export interface CancelReason {
  /** Free-text `flow_runs.cancel_reason` / `agent_runs.cancel_reason`. */
  db: string;
  /** What the device cancel frame carries (narrow protocol enum). */
  wire: WireCancelReason;
}

export async function cancelFlowRun(
  deps: CancelFlowRunDeps,
  run: { id: string; projectId: string },
  reason: CancelReason,
  /** Human-readable cause surfaced in `flow_runs.error` (run page header). */
  error?: string,
): Promise<CancelFlowRunResult> {
  // The status predicate races against the engine's own terminal write (the
  // run could finish between the caller's SELECT and this UPDATE).
  // `.returning()` tells honestly whether we actually cancelled.
  const updated = await deps.db
    .update(flowRuns)
    .set({
      status: "cancelled",
      cancelReason: reason.db,
      finishedAt: new Date(),
      ...(error ? { error } : {}),
    })
    .where(and(eq(flowRuns.id, run.id), inArray(flowRuns.status, ["pending", "running"])))
    .returning({ id: flowRuns.id });
  if (updated.length === 0) return { cancelled: false, signalled: 0 };

  // Flip the in-flight agent_runs rows and signal the device to actually
  // kill the process. Without the WS frame, "cancelled" here was purely
  // cosmetic — the agent kept executing on the device (and could still
  // push commits / open PRs) until it finished naturally.
  let signalled = 0;
  if (deps.dispatcher) {
    ({ signalled } = await cancelFlowRunAgents(deps.db, deps.dispatcher, run.id, reason.wire));
  }
  // Wake SSE listeners (both /flow-runs/:id/events/stream and the kanban
  // board, which LISTENs on `flow_runs` to refresh implement statuses).
  void deps.pg.notify(
    FLOW_RUNS_CHANNEL,
    serializeFlowRunsNotify({ flowRunId: run.id, projectId: run.projectId }),
  );
  return { cancelled: true, signalled };
}
