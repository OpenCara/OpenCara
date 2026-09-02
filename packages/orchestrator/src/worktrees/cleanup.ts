// PR-close worktree cleanup. Triggered from the
// `routes/webhooks.ts` handler on a `pull_request.closed` event
// (any sub-action — merged or closed-without-merge both invalidate
// the per-PR-branch checkout).
//
// Mechanism:
//   1. Look up every `worktree_pins` row for (owner_repo, head.ref) —
//      one per agent attempt that ran against the PR.
//   2. Dispatch `opencara internal worktree remove --key <slug>` to
//      each pin's device. This wipes both
//      ~/.opencara/work/<key>/checkout/ AND
//      ~/.opencara/sessions/<key>/.
//   3. Delete the pin rows.
//
// `pruneStaleWorktrees` covers checkouts no PR-close will ever reach
// (schedule / manual runs, PRs closed while the device was offline).
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
import { and, eq, lt } from "drizzle-orm";
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
  // Every attempt on this PR got its own checkout; remove all of them.
  const pins = await deps.db.query.worktreePins.findMany({
    where: and(eq(worktreePins.ownerRepo, ownerRepo), eq(worktreePins.branch, branch)),
  });
  for (const pin of pins) {
    await removePinnedWorktree(deps, pin, projectId);
  }
}

/** Default age after which an attempt's checkout is reclaimed. */
export const DEFAULT_WORKTREE_RETENTION_DAYS = 3;

/**
 * Reclaim checkouts that no PR-close event will ever remove — schedule /
 * manual runs, PRs closed while the device was offline, anything older than
 * the retention window. Nothing reuses a worktree after its attempt finished
 * (every attempt clones afresh), so removing an old one is always safe.
 * Returns the number of pins processed.
 */
export async function pruneStaleWorktrees(
  deps: CleanupDeps,
  retentionDays: number = DEFAULT_WORKTREE_RETENTION_DAYS,
  now: Date = new Date(),
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 24 * 60 * 60 * 1000);
  const pins = await deps.db.query.worktreePins.findMany({
    where: lt(worktreePins.lastRunAt, cutoff),
  });
  for (const pin of pins) {
    await removePinnedWorktree(deps, pin, null);
  }
  return pins.length;
}

type PinRow = typeof worktreePins.$inferSelect;

async function removePinnedWorktree(
  deps: CleanupDeps,
  pin: PinRow,
  projectId: string | null,
): Promise<void> {
  const { ownerRepo, branch, key } = pin;

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
        runId,
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
    // we still drop the pin row so nothing keeps targeting the dead
    // device. The orphaned dir on the device, if it ever comes back,
    // is an operator concern.
    console.warn("[worktree-cleanup] dispatch failed", { ownerRepo, branch, key, hostId: pin.hostId, err });
    await deps.db
      .update(agentRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(agentRuns.id, runId));
  }

  await deps.db.delete(worktreePins).where(eq(worktreePins.id, pin.id));
}
