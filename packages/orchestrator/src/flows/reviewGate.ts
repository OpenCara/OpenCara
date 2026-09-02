/**
 * Per-PR review gate: at most ONE review run executes at a time for a given
 * pull request — across both review flows (multi + single) — with at most one
 * more waiting behind it. A third request while one is already queued is
 * discarded: the queued run will review the newest state of the PR anyway.
 *
 * In-process by design: the orchestrator is a single instance and a run's
 * execution lives in this process, so the map here IS the truth; the DB only
 * mirrors it (queued runs sit at status `pending` with a note in `error`).
 * A waiter polls `isCancelled` so a queued run that gets pre-empted or
 * stopped from the UI leaves the queue instead of running later.
 */

export type GateVerdict = "run" | "discard" | "cancelled";

interface Waiter {
  runId: string;
  resolve: (v: "run") => void;
}

interface Slot {
  running: string | null;
  queued: Waiter | null;
}

export interface AcquireHooks {
  /** Called once when the run has to wait; `aheadRunId` is the running one. */
  onQueued?: (aheadRunId: string) => Promise<void> | void;
  /** Called when a queued run is promoted to running. */
  onResumed?: () => Promise<void> | void;
  /** Polled while waiting; true = give up (run was cancelled meanwhile). */
  isCancelled?: () => Promise<boolean> | boolean;
  /** Poll interval for `isCancelled`, ms. Default 5000. */
  pollMs?: number;
}

export class ReviewGate {
  private slots = new Map<string, Slot>();

  /** Snapshot for tests / diagnostics. */
  state(key: string): { running: string | null; queued: string | null } {
    const s = this.slots.get(key);
    return { running: s?.running ?? null, queued: s?.queued?.runId ?? null };
  }

  async acquire(key: string, runId: string, hooks: AcquireHooks = {}): Promise<GateVerdict> {
    const slot = this.slots.get(key) ?? { running: null, queued: null };
    this.slots.set(key, slot);

    if (slot.running === null) {
      slot.running = runId;
      return "run";
    }
    if (slot.running === runId) return "run";
    if (slot.queued !== null) return "discard";

    let resolveRun!: (v: "run") => void;
    const promoted = new Promise<"run">((r) => (resolveRun = r));
    slot.queued = { runId, resolve: resolveRun };
    await hooks.onQueued?.(slot.running);

    const pollMs = hooks.pollMs ?? 5000;
    for (;;) {
      const winner = await Promise.race([
        promoted,
        new Promise<"tick">((r) => setTimeout(() => r("tick"), pollMs)),
      ]);
      if (winner === "run") {
        await hooks.onResumed?.();
        return "run";
      }
      if (await hooks.isCancelled?.()) {
        if (slot.queued?.runId === runId) slot.queued = null;
        this.prune(key, slot);
        return "cancelled";
      }
    }
  }

  /** Release the running slot; promotes the queued run, if any. */
  release(key: string, runId: string): void {
    const slot = this.slots.get(key);
    if (!slot || slot.running !== runId) return;
    slot.running = null;
    if (slot.queued) {
      const next = slot.queued;
      slot.queued = null;
      slot.running = next.runId;
      next.resolve("run");
    }
    this.prune(key, slot);
  }

  private prune(key: string, slot: Slot): void {
    if (slot.running === null && slot.queued === null) this.slots.delete(key);
  }
}

/** PR number a trigger event concerns (pull_request or a PR's issue_comment). */
export function eventPullRequestNumber(payload: unknown): number | null {
  const p = payload as {
    pull_request?: { number?: unknown };
    issue?: { number?: unknown; pull_request?: unknown };
  } | null;
  if (typeof p?.pull_request?.number === "number") return p.pull_request.number;
  if (p?.issue?.pull_request && typeof p.issue.number === "number") return p.issue.number;
  return null;
}

/**
 * Gate key for a run, or null when the run is not a PR review (no matched
 * `scm.pull_request` trigger, or no PR number on the event).
 */
export function reviewGateKeyFor(
  def: { nodes: ReadonlyArray<{ id: string; kind: string }> },
  matchedTriggerIds: Iterable<string>,
  event: { payload: unknown },
  projectId: string,
): string | null {
  const matched = new Set(matchedTriggerIds);
  const isReview = def.nodes.some((n) => matched.has(n.id) && n.kind === "scm.pull_request");
  if (!isReview) return null;
  const pr = eventPullRequestNumber(event.payload);
  return pr === null ? null : `${projectId}:pr:${pr}`;
}
