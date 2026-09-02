import type { AgentRow, FlowNodeSetting, PromptRow, TemplateNodeSetting } from "./queries";
import type { FlowNodeDisplay } from "@/components/flow/FlowGraph";

type NodeSetting = FlowNodeSetting | TemplateNodeSetting;

/** The node's agent pool in priority order: primary first, then fallbacks. */
export function poolAgentIds(setting: Pick<NodeSetting, "agentId" | "fallbackAgentIds">): string[] {
  const ids = setting.agentId ? [setting.agentId] : [];
  for (const id of setting.fallbackAgentIds ?? []) if (!ids.includes(id)) ids.push(id);
  return ids;
}

export function agentDisplayName(id: string, agents: readonly AgentRow[]): string {
  return agents.find((a) => a.id === id)?.name ?? `(deleted agent …${id.slice(-6)})`;
}

/**
 * Per-node display for the flow graph. An agent node reads top to bottom as
 *
 *   <prompt name>          (or the node's label when no prompt is linked)
 *   <agent 1 name>
 *   <agent 2 name>
 *   …
 *
 * i.e. the pool in priority order, the first entry being the node's primary.
 * Other node kinds only get a label override when the operator renamed them.
 *
 * `ranAgentNames` (run view) replaces the configured pool with the agents
 * that actually ran, in attempt order — an `agent:<name>` label or the
 * project default can outrank the node's own list.
 */
export function buildFlowNodeDisplays(
  nodes: readonly { id: string; kind: string }[],
  settings: readonly NodeSetting[],
  agents: readonly AgentRow[],
  prompts: readonly PromptRow[],
  ranAgentNames?: Record<string, string[]>,
): Record<string, FlowNodeDisplay> {
  const promptNameById = new Map(prompts.map((p) => [p.id, p.name]));
  const kindByNodeId = new Map(nodes.map((n) => [n.id, n.kind]));
  const settingByNodeId = new Map(settings.map((s) => [s.nodeId, s]));
  const out: Record<string, FlowNodeDisplay> = {};
  for (const n of nodes) {
    const s = settingByNodeId.get(n.id);
    if (kindByNodeId.get(n.id) !== "agent") {
      if (s?.label) out[n.id] = { label: s.label };
      continue;
    }
    const promptName = s?.promptId ? promptNameById.get(s.promptId) : undefined;
    const ran = ranAgentNames?.[n.id];
    const lines =
      ran && ran.length > 0 ? ran : s ? poolAgentIds(s).map((id) => agentDisplayName(id, agents)) : [];
    const display: FlowNodeDisplay = { lines };
    const label = promptName ?? s?.label ?? undefined;
    if (label) display.label = label;
    out[n.id] = display;
  }
  return out;
}
