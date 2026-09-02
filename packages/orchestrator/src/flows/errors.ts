/**
 * Error markers the flow engine's agent-pool loop keys its policy on. Kept
 * dependency-free so the pure pool logic (agentPool.ts) and its tests never
 * pull in the DB-heavy node runners.
 */

/** The run should stop cleanly (flow status `cancelled`), not fail. */
export class SkipFlowError extends Error {
  /**
   * Optional `flow_runs.cancel_reason` for this skip. Defaults to the
   * generic `trigger_skip` (hidden by the runs page filter); a skip an
   * operator should still see — e.g. a review cancelled by its grace period
   * — names its own reason.
   */
  readonly cancelReason: string | null;
  constructor(reason: string, cancelReason: string | null = null) {
    super(reason);
    this.name = "SkipFlowError";
    this.cancelReason = cancelReason;
  }
}

/**
 * This candidate agent cannot run at all (kind not ACP-eligible, row
 * deleted, …). Retrying it is pointless — the pool moves straight to the
 * next candidate regardless of `retrySame`.
 */
export class AgentUnusableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnusableError";
  }
}

/**
 * The node's own configuration is broken (unrenderable template, empty
 * branch name, …). Identical for every candidate, so the pool aborts
 * immediately instead of burning attempts.
 */
export class FlowConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlowConfigError";
  }
}
