import { clampConcurrency, clampQuorum, clampRetrySame } from "../../flows/agentPool.js";

/** Sentinel for "field absent from the PATCH body — leave it alone". */
export const KEEP = "__keep__" as const;
export type Keep = typeof KEEP;

/** Hard cap on fallback list length; keeps the editor + failover trail sane. */
export const FALLBACK_AGENTS_MAX = 8;

export interface AgentPoolPatch {
  fallbackAgentIds: string[] | Keep;
  retrySame: number | Keep;
  concurrency: number | Keep;
  quorum: number | Keep;
}

/**
 * Parse the agent-pool fields off a node-settings PUT body. Shared by the
 * project-flow and template routes so both accept the same shape:
 *   fallbackAgentIds?: string[]   — ordered, deduped, ≤ FALLBACK_AGENTS_MAX
 *   retrySame?: number            — clamped to [0, RETRY_SAME_MAX]
 *   concurrency?: number          — clamped to [1, CONCURRENCY_MAX]
 *   quorum?: number               — clamped to [1, CONCURRENCY_MAX] (the
 *                                   runner caps it to the live target)
 * Returns `{ error }` for a malformed value instead of silently coercing,
 * so a UI bug can't quietly wipe a pool.
 */
export function parseAgentPoolPatch(
  body: Record<string, unknown>,
): AgentPoolPatch | { error: string } {
  let fallbackAgentIds: string[] | Keep = KEEP;
  if (body.fallbackAgentIds !== undefined) {
    const raw = body.fallbackAgentIds;
    if (!Array.isArray(raw) || raw.some((x) => typeof x !== "string" || x.length === 0)) {
      return { error: "fallbackAgentIds must be an array of agent ids" };
    }
    const deduped = Array.from(new Set(raw as string[]));
    if (deduped.length > FALLBACK_AGENTS_MAX) {
      return { error: `fallbackAgentIds: at most ${FALLBACK_AGENTS_MAX} fallback agents` };
    }
    fallbackAgentIds = deduped;
  }
  let retrySame: number | Keep = KEEP;
  if (body.retrySame !== undefined) {
    if (typeof body.retrySame !== "number" || !Number.isFinite(body.retrySame)) {
      return { error: "retrySame must be a number" };
    }
    retrySame = clampRetrySame(body.retrySame);
  }
  const concurrency = parseClampedInt(body.concurrency, "concurrency", clampConcurrency);
  if (typeof concurrency === "object") return concurrency;
  const quorum = parseClampedInt(body.quorum, "quorum", clampQuorum);
  if (typeof quorum === "object") return quorum;
  return { fallbackAgentIds, retrySame, concurrency, quorum };
}

function parseClampedInt(
  raw: unknown,
  name: string,
  clamp: (v: unknown) => number,
): number | Keep | { error: string } {
  if (raw === undefined) return KEEP;
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return { error: `${name} must be a number` };
  }
  return clamp(raw);
}
