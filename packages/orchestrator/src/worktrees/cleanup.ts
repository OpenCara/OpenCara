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

/**
 * Remove ONE attempt's checkout right after the attempt finishes. Nothing
 * reads a worktree once its agent exits (steering chat resumes by session id,
 * not by cwd), so the engine calls this from `runAgentAttempt`'s finally.
 * No-op when the pin is already gone.
 */
export async function removeAttemptWorktree(
  deps: CleanupDeps,
  key: string,
  projectId: string | null,
): Promise<void> {
  const pin = await deps.db.query.worktreePins.findFirst({ where: eq(worktreePins.key, key) });
  if (!pin) return;
  await removePinnedWorktree(deps, pin, projectId);
}

/**
 * Pins normally live only as long as their attempt (see
 * `removeAttemptWorktree`). One this old is a leftover from an orchestrator
 * crash or a device that was offline at teardown.
 */
export const DEFAULT_WORKTREE_RETENTION_DAYS = 1;

/**
 * Reclaim checkouts whose after-attempt teardown never happened — anything
 * older than the retention window. Nothing reuses a worktree after its
 * attempt finished (every attempt clones afresh), so removing an old one is
 * always safe. Returns the number of pins processed.
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
  // Best-effort: an unreachable device is logged inside runInternalOnHost
  // and the pin row is dropped regardless, so nothing keeps targeting a
  // dead host. The orphaned dir, if the device ever comes back, is what
  // its own `worktree gc` sweep is for.
  await runInternalOnHost(
    deps,
    pin.hostId,
    "internal:worktree-remove",
    ["internal", "worktree", "remove", "--key", pin.key],
    projectId,
  );
  await deps.db.delete(worktreePins).where(eq(worktreePins.id, pin.id));
}

/** Checkouts on a device older than this with no live pin are swept. */
export const DEFAULT_DEVICE_GC_MAX_AGE_HOURS = 24;

/**
 * Device-side detection of worktrees the orchestrator has lost track of:
 * asks every connected device to `worktree gc`, keeping only the keys of
 * this host's live pins (in-flight attempts). Catches checkouts whose pin
 * row is gone, legacy per-branch checkouts, and half-built dirs from a
 * crashed allocation. A device on a CLI predating `gc` rejects the op;
 * that is logged and skipped. Returns the number of devices swept.
 */
export async function sweepDeviceWorktrees(
  deps: CleanupDeps,
  maxAgeHours: number = DEFAULT_DEVICE_GC_MAX_AGE_HOURS,
): Promise<number> {
  const hosts = deps.dispatcher.connectedHostIds?.() ?? [];
  let swept = 0;
  for (const hostId of hosts) {
    const pins = await deps.db.query.worktreePins.findMany({
      where: eq(worktreePins.hostId, hostId),
    });
    const args = [
      "internal",
      "worktree",
      "gc",
      "--max-age-hours",
      String(maxAgeHours),
      ...pins.flatMap((p) => ["--keep", p.key]),
    ];
    const result = await runInternalOnHost(deps, hostId, "internal:worktree-gc", args, null);
    if (result === null) continue;
    swept++;
    if (result.exitCode !== 0) {
      console.warn("[worktree-gc] device sweep failed", { hostId, exitCode: result.exitCode });
    } else if (result.stdoutCaptured.includes('"removed":[')) {
      const summary = result.stdoutCaptured.trim().split("\n").pop() ?? "";
      if (!summary.includes('"removed":[]')) console.log("[worktree-gc] swept", { hostId, summary });
    }
  }
  return swept;
}

/**
 * Dispatch one `opencara internal …` housekeeping command to a specific
 * device, persisted as an agent_runs row for audit. Returns null when the
 * device could not be reached (offline / revoked) — the caller decides what
 * that means for its bookkeeping.
 */
async function runInternalOnHost(
  deps: CleanupDeps,
  hostId: string,
  kind: string,
  args: string[],
  projectId: string | null,
): Promise<{ exitCode: number; stdoutCaptured: string } | null> {
  const runId = ulid();
  const spec = { kind, command: "opencara", args, env: {} };
  await deps.db.insert(agentRuns).values({
    id: runId,
    spec,
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
    const result = await deps.dispatcher.run(spec, { runId, onLog, hostId, projectId });
    await deps.db
      .update(agentRuns)
      .set({
        status: result.exitCode === 0 ? "succeeded" : "failed",
        exitCode: result.exitCode,
        finishedAt: new Date(),
      })
      .where(eq(agentRuns.id, runId));
    return { exitCode: result.exitCode, stdoutCaptured: result.stdoutCaptured };
  } catch (err) {
    console.warn("[worktree-cleanup] dispatch failed", { kind, hostId, err });
    await deps.db
      .update(agentRuns)
      .set({ status: "failed", finishedAt: new Date() })
      .where(eq(agentRuns.id, runId));
    return null;
  }
}
