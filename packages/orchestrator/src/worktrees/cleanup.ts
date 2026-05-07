// PR-close worktree cleanup. Triggered from the
// `routes/webhooks.ts` handler on a `pull_request.closed` event
// (any sub-action — merged or closed-without-merge both invalidate
// the per-PR-branch checkout).
//
// Mechanism:
//   1. Look up `worktree_pins` for (owner_repo, head.ref).
//   2. Dispatch `opencara internal worktree remove --key <slug>` to
//      the pinned device. This wipes both
//      ~/.opencara/work/<key>/checkout/ AND
//      ~/.opencara/sessions/<key>/agent-session.json so the next PR
//      that lands on the same branch name (rare but possible) starts
//      fresh.
//   3. Delete the pin row.
//
// Best-effort: dispatch failures are logged + ignored, and the pin
// row is deleted regardless. Worst case is an orphaned worktree dir
// on a since-disconnected device that an operator sweeps manually.
//
// We do NOT route this through the agent-runs / flow-runs tables
// because it isn't tied to any flow run and we don't want PR-close
// noise to clutter the activity feed. The dispatcher is invoked
// directly with a no-op log handler.

import { ulid } from "ulid";
import { and, eq } from "drizzle-orm";
import type { Sql } from "postgres";
import type { Db } from "../db/client.js";
import { agentRunLogs, agentRuns, worktreePins } from "../db/schema.js";
import type { AgentDispatcher } from "../dispatch/dispatcher.js";

interface CleanupDeps {
  db: Db;
  pg: Sql;
  dispatcher: AgentDispatcher;
}

export async function cleanupClosedPrWorktree(
  deps: CleanupDeps,
  ownerRepo: string,
  branch: string,
  projectId: string | null,
): Promise<void> {
  const pin = await deps.db.query.worktreePins.findFirst({
    where: and(eq(worktreePins.ownerRepo, ownerRepo), eq(worktreePins.branch, branch)),
  });
  if (!pin) return;

  const safeBranch = branch.replace(/[^A-Za-z0-9._-]/g, "_");
  const key = `${ownerRepo}/branch-${safeBranch}`;

  // Persist the cleanup as an agent_runs row for audit (so an operator
  // can see "we asked the device to remove the worktree at <time>")
  // even though it isn't tied to a flow_run_step.
  const runId = ulid();
  await deps.db.insert(agentRuns).values({
    id: runId,
    spec: {
      kind: "internal:worktree-remove",
      command: "opencara",
      args: ["internal", "worktree", "remove", "--key", key],
      env: {},
    },
    status: "running",
    projectId,
    flowRunStepId: null,
    startedAt: new Date(),
  });

  let seq = 0;
  const onLog = (stream: "stdout" | "stderr", chunk: string) => {
    const mySeq = seq++;
    void deps.db
      .insert(agentRunLogs)
      .values({ agentRunId: runId, seq: mySeq, stream, chunk })
      .then(() => deps.pg.notify("agent_run_logs", runId))
      .catch(() => undefined);
  };

  try {
    const result = await deps.dispatcher.run(
      {
        kind: "internal:worktree-remove",
        command: "opencara",
        args: ["internal", "worktree", "remove", "--key", key],
        env: {},
      },
      {
        onLog,
        hostId: pin.hostId,
        projectId,
      },
    );
    await deps.db
      .update(agentRuns)
      .set({
        status: result.exitCode === 0 ? "succeeded" : "failed",
        exitCode: result.exitCode,
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));
  } catch (err) {
    // The pinned device may be offline or revoked. Log + proceed —
    // we still drop the pin row so a future PR on this branch
    // doesn't keep targeting the dead device. The orphaned dir on
    // the device, if it ever comes back, is an operator concern.
    console.warn("[worktree-cleanup] dispatch failed", { ownerRepo, branch, hostId: pin.hostId, err });
    await deps.db
      .update(agentRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(agentRuns.id, runId));
  }

  await deps.db.delete(worktreePins).where(eq(worktreePins.id, pin.id));
}
