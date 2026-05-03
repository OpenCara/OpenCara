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
  config?: { label?: string; event?: string; spec?: { command?: string }; labels?: string[] };
}
export interface FlowGraphEdge {
  id: string;
  source: string;
  target: string;
}

interface FlowGraphProps {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  /** Map node id → step status (for run-coloured graph). Optional. */
  stepStatuses?: Record<string, StepStatus>;
  /** Map node id → custom display label (rename). Optional. */
  labelOverrides?: Record<string, string>;
  onNodeClick?: (nodeId: string) => void;
}

export function FlowGraph({
  nodes,
  edges,
  stepStatuses,
  labelOverrides,
  onNodeClick,
}: FlowGraphProps) {
  const rfNodes = useMemo<Node[]>(
    () => nodes.map((n) => mapNode(n, stepStatuses, labelOverrides)),
    [nodes, stepStatuses, labelOverrides],
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
  overrides?: Record<string, string>,
): Node {
  const type = nodeTypeFor(n.kind);
  const label = overrides?.[n.id] ?? pickLabel(n);
  const subtitle = pickSubtitle(n);
  const status = statuses?.[n.id] ?? "idle";
  return {
    id: n.id,
    type,
    position: n.position,
    data: { label, subtitle, status },
  };
}

function nodeTypeFor(kind: string): string {
  if (kind === "agent") return "agent";
  if (kind === "github.post_review") return "postReview";
  if (kind === "github.add_comment") return "addComment";
  if (kind === "github.add_label") return "addLabel";
  return "trigger";
}

function pickLabel(n: FlowGraphNode): string {
  switch (n.kind) {
    case "github.pull_request":
      return "Pull request";
    case "github.projects_v2_item":
      return "Project status change";
    case "agent":
      return n.config?.label ?? "Agent";
    case "github.post_review":
      return "Post PR review";
    case "github.add_comment":
      return "Add comment";
    case "github.add_label":
      return "Add label";
    default:
      return n.kind;
  }
}

function pickSubtitle(n: FlowGraphNode): string | undefined {
  switch (n.kind) {
    case "github.pull_request":
      return "trigger";
    case "github.projects_v2_item":
      return "trigger";
    case "agent":
      return n.config?.spec?.command ?? undefined;
    case "github.post_review":
      return n.config?.event;
    case "github.add_label":
      return n.config?.labels?.join(", ");
    default:
      return undefined;
  }
}
