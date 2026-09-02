/**
 * Error markers the flow engine's agent-pool loop keys its policy on. Kept
 * dependency-free so the pure pool logic (agentPool.ts) and its tests never
 * pull in the DB-heavy node runners.
 */

/** The run should stop cleanly (flow status `cancelled`), not fail. */
export class SkipFlowError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "SkipFlowError";
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
