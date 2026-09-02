import type { FlowRunStep, FlowRunSummary } from "@/lib/queries";
import type { StepStatus } from "@/components/flow/nodes";

export interface StepPoolMeta {
  agentId: string;
  agentName: string;
  candidateIndex: number;
  retryIndex: number;
  candidateCount: number;
  retrySame: number;
  concurrency: number;
  quorum: number;
}

// Engine stamps `pool` onto agent-attempt steps (engine.runStepAttempt) so
// the UI can say where an attempt sits in the node's failover list and what
// the node needed to succeed.
export function parsePoolMeta(inputJson: unknown): StepPoolMeta | null {
  if (!inputJson || typeof inputJson !== "object") return null;
  const pool = (inputJson as { pool?: unknown }).pool;
  if (!pool || typeof pool !== "object") return null;
  const o = pool as Partial<StepPoolMeta>;
  if (
    typeof o.agentName !== "string" ||
    typeof o.candidateIndex !== "number" ||
    typeof o.retryIndex !== "number" ||
    typeof o.candidateCount !== "number"
  ) {
    return null;
  }
  return {
    agentId: typeof o.agentId === "string" ? o.agentId : "",
    agentName: o.agentName,
    candidateIndex: o.candidateIndex,
    retryIndex: o.retryIndex,
    candidateCount: o.candidateCount,
    retrySame: typeof o.retrySame === "number" ? o.retrySame : 0,
    concurrency: typeof o.concurrency === "number" ? o.concurrency : 1,
    quorum: typeof o.quorum === "number" ? o.quorum : 1,
  };
}

/** All attempt rows per node, ascending by `attempt`. */
export function groupAttemptsByNode(steps: readonly FlowRunStep[]): Map<string, FlowRunStep[]> {
  const m = new Map<string, FlowRunStep[]>();
  for (const s of steps) {
    const list = m.get(s.nodeId);
    if (list) list.push(s);
    else m.set(s.nodeId, [s]);
  }
  for (const list of m.values()) list.sort((a, b) => a.attempt - b.attempt);
  return m;
}

/**
 * A node's outcome from ALL its attempts — the same rule the engine applies
 * (agentPool.ts): the node succeeds once `quorum` attempts succeeded, no
 * matter how many others failed; it fails only when it finished below quorum.
 * With parallel slots the highest attempt ordinal is NOT the node's fate
 * (the last-started agent can fail while an earlier one succeeded), so the
 * status must be aggregated, not read off one row.
 */
export function aggregateNodeStatus(
  attempts: readonly FlowRunStep[],
  runStatus: FlowRunSummary["status"],
): StepStatus {
  if (attempts.length === 0) return "pending";
  if (attempts.some((a) => a.status === "running")) return "running";
  if (attempts.every((a) => a.status === "pending")) return "pending";
  if (attempts.some((a) => a.status === "pending")) return "running";

  let quorum = 1;
  for (const a of attempts) {
    const q = parsePoolMeta(a.inputJson)?.quorum;
    if (q && q > quorum) quorum = q;
  }
  const succeeded = attempts.filter((a) => a.status === "succeeded").length;
  if (succeeded >= quorum) return "succeeded";
  if (attempts.some((a) => a.status === "skipped")) return "skipped";
  // Below quorum with nothing in flight. While the run is still going, a
  // pool with candidates or retries left may be about to start its next
  // attempt (the row doesn't exist yet), so hold the failed paint for THAT
  // case only; a node with nothing left to try is failed right away.
  if ((runStatus === "running" || runStatus === "pending") && poolHasAttemptsLeft(attempts)) {
    return "running";
  }
  return "failed";
}

function poolHasAttemptsLeft(attempts: readonly FlowRunStep[]): boolean {
  let meta: StepPoolMeta | null = null;
  let maxCandidateIndex = -1;
  let retryLeft = false;
  for (const a of attempts) {
    const m = parsePoolMeta(a.inputJson);
    if (!m) continue;
    meta = m;
    if (m.candidateIndex > maxCandidateIndex) maxCandidateIndex = m.candidateIndex;
    if (a.status === "failed" && m.retryIndex < m.retrySame) retryLeft = true;
  }
  if (!meta) return false;
  return retryLeft || maxCandidateIndex < meta.candidateCount - 1;
}

/**
 * The step "Rerun from failed step" should resume from: the latest failed
 * attempt of the first node whose aggregated outcome is failed. Only ever
 * offered on a failed run — a succeeded run can still contain failed pool
 * attempts that were absorbed by failover.
 */
export function pickFailedStep(
  attemptsByNode: Map<string, FlowRunStep[]>,
  run: FlowRunSummary,
): FlowRunStep | null {
  if (run.status !== "failed") return null;
  for (const attempts of attemptsByNode.values()) {
    if (aggregateNodeStatus(attempts, run.status) !== "failed") continue;
    const failed = [...attempts].reverse().find((a) => a.status === "failed");
    if (failed) return failed;
  }
  return null;
}
