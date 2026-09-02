/**
 * Folding the pre-pool multi-review shape into the pool reviewer node.
 *
 * The development-lifecycle template used to fan the PR trigger out to N
 * sibling reviewer nodes (`reviewer_correctness`, `reviewer_performance`,
 * `reviewer_style`, plus operator-added `reviewer_<rand>` nodes), one agent
 * each, all sharing one prompt. That is exactly an agent pool with
 * concurrency N, so when a flow/template picks up the new graph (single
 * `reviewer` node) its legacy per-node links are folded into one pool row:
 * first agent = primary, the rest = fallbacks, concurrency = how many ran in
 * parallel before, quorum 1 ("keep whatever finishes").
 *
 * Pure; the DB glue lives in flows/builtin.ts.
 */
import { CONCURRENCY_MAX } from "./agentPool.js";

export const POOL_REVIEWER_NODE_ID = "reviewer";

/** The template's historical fixed reviewer ids, in display order. */
const LEGACY_FIXED_ORDER = ["reviewer_correctness", "reviewer_performance", "reviewer_style"];

export function isLegacyReviewerNodeId(nodeId: string): boolean {
  return nodeId !== POOL_REVIEWER_NODE_ID && nodeId.startsWith("reviewer_");
}

export function graphHasPoolReviewer(nodes: ReadonlyArray<{ id: string; kind: string }>): boolean {
  return nodes.some((n) => n.id === POOL_REVIEWER_NODE_ID && n.kind === "agent");
}

export interface LegacyReviewerRow {
  /** Settings row id (a ulid) — used to order operator-added reviewers by creation. */
  id: string;
  nodeId: string;
  agentId: string | null;
  promptId: string | null;
  fallbackAgentIds: readonly string[];
}

export interface FoldedReviewerPool {
  agentId: string;
  fallbackAgentIds: string[];
  promptId: string | null;
  concurrency: number;
  quorum: number;
  /** Legacy node ids that contributed, in the order they were folded. */
  sourceNodeIds: string[];
}

/**
 * Fold legacy reviewer rows into one pool. Returns null when no row carries
 * an agent (nothing to migrate). Order: the template's fixed ids first, then
 * operator-added reviewers by settings-row creation; each row contributes
 * its primary then its own fallbacks; duplicates collapse to first position.
 */
export function foldLegacyReviewerSettings(
  rows: readonly LegacyReviewerRow[],
): FoldedReviewerPool | null {
  const legacy = rows.filter((r) => isLegacyReviewerNodeId(r.nodeId));
  const rank = (r: LegacyReviewerRow) => {
    const i = LEGACY_FIXED_ORDER.indexOf(r.nodeId);
    return i === -1 ? LEGACY_FIXED_ORDER.length : i;
  };
  const ordered = [...legacy].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));

  const agentIds: string[] = [];
  const seen = new Set<string>();
  const push = (id: string | null | undefined) => {
    if (!id || seen.has(id)) return;
    seen.add(id);
    agentIds.push(id);
  };
  let promptId: string | null = null;
  let parallel = 0;
  const sourceNodeIds: string[] = [];
  for (const r of ordered) {
    if (r.agentId) parallel++;
    push(r.agentId);
    for (const id of r.fallbackAgentIds) push(id);
    if (promptId === null && r.promptId) promptId = r.promptId;
    sourceNodeIds.push(r.nodeId);
  }
  if (agentIds.length === 0) return null;
  return {
    agentId: agentIds[0]!,
    fallbackAgentIds: agentIds.slice(1),
    promptId,
    concurrency: Math.min(CONCURRENCY_MAX, Math.max(1, parallel)),
    quorum: 1,
    sourceNodeIds,
  };
}
