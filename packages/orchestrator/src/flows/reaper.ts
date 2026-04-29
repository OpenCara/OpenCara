import { inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agentRuns, flowRunSteps, flowRuns } from "../db/schema.js";

const REASON = "abandoned by orchestrator restart";

/**
 * On boot, drive every flow_run / flow_run_step / agent_run still in a
 * non-terminal state to a terminal one. These are runs whose owning Promise
 * was lost when the previous orchestrator process died (`tsx watch` reload,
 * crash, deploy). Without this they stay "running" forever and the UI never
 * resolves them.
 */
export async function reapOrphanedRuns(
  db: Db,
): Promise<{ agentRuns: number; steps: number; flowRuns: number }> {
  // agent_runs: cancelled (terminal). Closes the matching SSE log streams.
  const agent = await db
    .update(agentRuns)
    .set({ status: "cancelled", finishedAt: sql`COALESCE(${agentRuns.finishedAt}, NOW())` })
    .where(inArray(agentRuns.status, ["queued", "assigned", "running"]))
    .returning({ id: agentRuns.id });

  // flow_run_steps has no 'cancelled' state — use 'failed' with a reason
  // string so the UI can show why this didn't finish.
  const step = await db
    .update(flowRunSteps)
    .set({
      status: "failed",
      finishedAt: sql`COALESCE(${flowRunSteps.finishedAt}, NOW())`,
      error: sql`COALESCE(${flowRunSteps.error}, ${REASON})`,
    })
    .where(inArray(flowRunSteps.status, ["pending", "running"]))
    .returning({ id: flowRunSteps.id });

  // flow_runs: cancelled (we didn't fail; the system terminated it).
  const flow = await db
    .update(flowRuns)
    .set({
      status: "cancelled",
      error: sql`COALESCE(${flowRuns.error}, ${REASON})`,
    })
    .where(inArray(flowRuns.status, ["pending", "running"]))
    .returning({ id: flowRuns.id });

  return { agentRuns: agent.length, steps: step.length, flowRuns: flow.length };
}
