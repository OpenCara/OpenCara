import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  type Edge,
  type Node,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { flowNodeTypes, type StepStatus } from "./nodes";

export interface FlowGraphNode {
  id: string;
  kind: string;
  position: { x: number; y: number };
  config?: {
    label?: string;
    event?: string;
    spec?: { command?: string };
    labels?: string[];
    /** AgentNode worktree option — when set, shows up as a branch
     *  hint on the agent node's subtitle. */
    worktree?: { branchName?: string };
    /** ProjectsV2 trigger filters — surfaced on the graph card as
     *  e.g. "Status: Backlog → Ready". */
    fromOptions?: string[];
    toOptions?: string[];
    fieldName?: string;
    /** schedule.cron trigger config — surfaced as the node title + subtitle. */
    name?: string;
    cron?: string;
    timezone?: string;
  };
}
export interface FlowGraphEdge {
  id: string;
  source: string;
  target: string;
}

/**
 * Per-node display override. Agent nodes use it to show their prompt name as
 * the title and their pool agents (priority order) as the rows beneath — see
 * `buildFlowNodeDisplays`.
 */
export interface FlowNodeDisplay {
  label?: string;
  lines?: string[];
}

interface FlowGraphProps {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  /** Map node id → step status (for run-coloured graph). Optional. */
  stepStatuses?: Record<string, StepStatus>;
  /** Map node id → display override, built by `buildFlowNodeDisplays`. Optional. */
  nodeDisplays?: Record<string, FlowNodeDisplay>;
  onNodeClick?: (nodeId: string) => void;
}

export function FlowGraph({
  nodes,
  edges,
  stepStatuses,
  nodeDisplays,
  onNodeClick,
}: FlowGraphProps) {
  const rfNodes = useMemo<Node[]>(
    () => nodes.map((n) => mapNode(n, stepStatuses, nodeDisplays)),
    [nodes, stepStatuses, nodeDisplays],
  );
  const rfEdges = useMemo<Edge[]>(
    () => edges.map((e) => ({ id: e.id, source: e.source, target: e.target, animated: false })),
    [edges],
  );

  return (
    <div className="h-[420px] w-full rounded-md border bg-muted/20">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={flowNodeTypes}
        nodesDraggable={false}
        nodesConnectable={false}
        edgesFocusable={false}
        edgesReconnectable={false}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        proOptions={{ hideAttribution: true }}
        onNodeClick={(_, node) => onNodeClick?.(node.id)}
      >
        <Background />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

function mapNode(
  n: FlowGraphNode,
  statuses?: Record<string, StepStatus>,
  displays?: Record<string, FlowNodeDisplay>,
): Node {
  const type = nodeTypeFor(n.kind);
  const display = displays?.[n.id];
  const label = display?.label ?? pickLabel(n);
  const lines = display?.lines;
  // An agent node with a pool display reads "prompt / agent / agent…"; the
  // branch-template subtitle would only crowd that, so it yields.
  const subtitle = lines && lines.length > 0 ? undefined : pickSubtitle(n);
  const status = statuses?.[n.id] ?? "idle";
  const data: Record<string, unknown> = { label, subtitle, lines, status };
  return { id: n.id, type, position: n.position, data };
}

function nodeTypeFor(kind: string): string {
  if (kind === "agent") return "agent";
  if (kind === "scm.post_review") return "postReview";
  if (kind === "scm.add_comment") return "addComment";
  if (kind === "scm.add_label") return "addLabel";
  return "trigger";
}

function pickLabel(n: FlowGraphNode): string {
  switch (n.kind) {
    case "scm.pull_request":
      return "Pull request";
    case "scm.pull_request_review":
      return "PR review submitted";
    case "scm.board_item":
      return "Project status change";
    case "schedule.cron":
      return n.config?.name ?? "Schedule";
    case "agent":
      return n.config?.label ?? "Agent";
    case "scm.post_review":
      return "Post PR review";
    case "scm.add_comment":
      return "Add comment";
    case "scm.add_label":
      return "Add label";
    default:
      return n.kind;
  }
}

function pickSubtitle(n: FlowGraphNode): string | undefined {
  switch (n.kind) {
    case "scm.pull_request":
      return "trigger";
    case "scm.pull_request_review":
      return "trigger";
    case "scm.board_item": {
      // Compose `Status: Backlog → Ready` from from/to options. * for empty.
      const field = n.config?.fieldName ?? "Status";
      const fromList = n.config?.fromOptions ?? [];
      const toList = n.config?.toOptions ?? [];
      const fromStr = fromList.length === 0 ? "*" : fromList.join("|");
      const toStr = toList.length === 0 ? "*" : toList.join("|");
      return `${field}: ${fromStr} → ${toStr}`;
    }
    case "schedule.cron": {
      const cron = n.config?.cron ?? "";
      const tz = n.config?.timezone ?? "UTC";
      return cron ? `${cron} (${tz})` : "trigger";
    }
    case "agent":
      // When the agent has a worktree option, show the branch
      // template instead of the (rarely-set) spec.command — the
      // branch is the more useful at-a-glance summary.
      return n.config?.worktree?.branchName ?? n.config?.spec?.command ?? undefined;
    case "scm.post_review":
      return n.config?.event;
    case "scm.add_label":
      return n.config?.labels?.join(", ");
    default:
      return undefined;
  }
}
