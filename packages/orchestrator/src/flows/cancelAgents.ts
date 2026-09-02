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

export async function cancelFlowRunAgents(
  db: Db,
  dispatcher: AgentDispatcher,
  flowRunId: string,
  reason: string,
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

  // The wire enum is narrower than the free-text DB column: any
  // `review_preempted_*` reason collapses onto the protocol's
  // `review_preempted`; older devices `.catch()` unknown values anyway.
  const wireReason: "user_stopped" | "wave_cancelled" | "review_preempted" =
    reason === "wave_cancelled"
      ? "wave_cancelled"
      : reason.startsWith("review_preempted")
        ? "review_preempted"
        : "user_stopped";
  let signalled = 0;
  for (const id of ids) {
    if (dispatcher.cancel(id, wireReason)) signalled += 1;
  }
  return { cancelled: ids.length, signalled };
}
