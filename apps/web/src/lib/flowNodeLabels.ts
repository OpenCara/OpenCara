import type { AgentRow, FlowNodeSetting, TemplateNodeSetting } from "./queries";

type NodeSetting = FlowNodeSetting | TemplateNodeSetting;

/**
 * Display label per node id for the flow graph, mirroring the orchestrator's
 * `buildNodeLabels` (packages/orchestrator/src/flows/engine.ts) so the canvas
 * shows the same name the synthesizer sees as its `## From <heading>` section
 * titles.
 *
 * An agent node is named by the AGENT linked to it, not by a per-node rename:
 * a fan-out of "Reviewer 1 / Reviewer 2 / Reviewer 3" (what the add-reviewer
 * route auto-labels clones) says nothing about what actually reviews the PR.
 * The stored label only survives on nodes with no agent linked.
 */
export function buildFlowNodeLabels(
  nodes: readonly { id: string; kind: string }[],
  settings: readonly NodeSetting[],
  agents: readonly AgentRow[],
): Record<string, string> {
  const agentNameById = new Map(agents.map((a) => [a.id, a.name]));
  const kindByNodeId = new Map(nodes.map((n) => [n.id, n.kind]));
  const out: Record<string, string> = {};
  for (const s of settings) {
    const agentName =
      kindByNodeId.get(s.nodeId) === "agent" && s.agentId
        ? agentNameById.get(s.agentId)
        : undefined;
    const label = agentName ?? s.label;
    if (label) out[s.nodeId] = label;
  }
  return out;
}
