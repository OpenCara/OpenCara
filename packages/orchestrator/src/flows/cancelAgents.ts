// Cancel the in-flight agent runs backing a flow run.
//
// Two halves, mirroring the chat stop endpoint (routes/api/chat.ts):
//  1. Guarded DB flip of the agent_runs rows — the load-bearing state the
//     SSE streams and run pages observe.
//  2. Best-effort `cancel` frame to the device via the dispatcher's
//     in-memory pending map — actual process termination. Without this,
//     "cancelled" in the UI still leaves the agent running on the device,
//     free to push commits and open PRs.
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentRuns, flowRunSteps } from "../db/schema.js";
import type { AgentDispatcher } from "../dispatch/dispatcher.js";

const IN_FLIGHT = ["queued", "assigned", "running"] as const;

/** Reasons the device cancel frame understands (shared host-protocol enum). */
export type WireCancelReason = "user_stopped" | "wave_cancelled" | "review_preempted";

export async function cancelFlowRunAgents(
  db: Db,
  dispatcher: AgentDispatcher,
  flowRunId: string,
  reason: WireCancelReason,
): Promise<{ cancelled: number; signalled: number }> {
  const rows = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .innerJoin(flowRunSteps, eq(agentRuns.flowRunStepId, flowRunSteps.id))
    .where(
      and(
        eq(flowRunSteps.flowRunId, flowRunId),
        inArray(agentRuns.status, [...IN_FLIGHT]),
      ),
    );
  if (rows.length === 0) return { cancelled: 0, signalled: 0 };

  const ids = rows.map((r) => r.id);
  await db
    .update(agentRuns)
    .set({ status: "cancelled", cancelReason: reason, finishedAt: new Date() })
    .where(
      and(inArray(agentRuns.id, ids), inArray(agentRuns.status, [...IN_FLIGHT])),
    );

  let signalled = 0;
  for (const id of ids) {
    if (dispatcher.cancel(id, reason)) signalled += 1;
  }
  return { cancelled: ids.length, signalled };
}

/** Cancel only the outstanding attempts of one agent-pool node. */
export async function cancelFlowNodeAttempts(
  db: Db,
  dispatcher: AgentDispatcher,
  flowRunId: string,
  nodeId: string,
  attempts: readonly number[],
): Promise<{ cancelled: number; signalled: number }> {
  if (attempts.length === 0) return { cancelled: 0, signalled: 0 };
  const steps = await db
    .select({ id: flowRunSteps.id })
    .from(flowRunSteps)
    .where(
      and(
        eq(flowRunSteps.flowRunId, flowRunId),
        eq(flowRunSteps.nodeId, nodeId),
        inArray(flowRunSteps.attempt, [...attempts]),
        eq(flowRunSteps.status, "running"),
      ),
    );
  if (steps.length === 0) return { cancelled: 0, signalled: 0 };

  const stepIds = steps.map((step) => step.id);
  const runs = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        inArray(agentRuns.flowRunStepId, stepIds),
        inArray(agentRuns.status, [...IN_FLIGHT]),
      ),
    );
  const runIds = runs.map((run) => run.id);
  if (runIds.length > 0) {
    await db
      .update(agentRuns)
      .set({ status: "cancelled", cancelReason: "wave_cancelled", finishedAt: new Date() })
      .where(and(inArray(agentRuns.id, runIds), inArray(agentRuns.status, [...IN_FLIGHT])));
  }
  await db
    .update(flowRunSteps)
    .set({ status: "skipped", error: "pool quorum reached", finishedAt: new Date() })
    .where(and(inArray(flowRunSteps.id, stepIds), eq(flowRunSteps.status, "running")));

  let signalled = 0;
  for (const id of runIds) {
    if (dispatcher.cancel(id, "wave_cancelled")) signalled += 1;
  }
  return { cancelled: runIds.length, signalled };
}
