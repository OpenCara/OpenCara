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
  };
}
export interface FlowGraphEdge {
  id: string;
  source: string;
  target: string;
}

/**
 * Enables in-canvas reviewer management on an editable flow. Omitted on the
 * read-only run view, so its delete buttons / add-reviewer node never render
 * there.
 */
export interface FlowReviewerControls {
  /** Node ids that are reviewers (from deriveReviewerIds). */
  reviewerIds: Set<string>;
  /** False when only one reviewer remains — hides the delete buttons. */
  canDelete: boolean;
  /** A reviewer add/remove mutation is in flight. */
  pending: boolean;
  onAdd: () => void;
  onDelete: (nodeId: string) => void;
}

/** Synthetic node id for the "+ Add reviewer" affordance (not a real graph node). */
export const ADD_REVIEWER_NODE_ID = "__add_reviewer__";

interface FlowGraphProps {
  nodes: FlowGraphNode[];
  edges: FlowGraphEdge[];
  /** Map node id → step status (for run-coloured graph). Optional. */
  stepStatuses?: Record<string, StepStatus>;
  /** Map node id → custom display label (rename). Optional. */
  labelOverrides?: Record<string, string>;
  /** When set, renders per-reviewer delete buttons + an add-reviewer node. */
  reviewerControls?: FlowReviewerControls;
  onNodeClick?: (nodeId: string) => void;
}

export function FlowGraph({
  nodes,
  edges,
  stepStatuses,
  labelOverrides,
  reviewerControls,
  onNodeClick,
}: FlowGraphProps) {
  const rfNodes = useMemo<Node[]>(() => {
    const mapped = nodes.map((n) => mapNode(n, stepStatuses, labelOverrides, reviewerControls));
    const rc = reviewerControls;
    if (rc && rc.reviewerIds.size > 0) {
      const reviewers = nodes.filter((n) => rc.reviewerIds.has(n.id));
      if (reviewers.length > 0) {
        const maxY = Math.max(...reviewers.map((n) => n.position.y));
        mapped.push({
          id: ADD_REVIEWER_NODE_ID,
          type: "addReviewer",
          position: { x: reviewers[0]!.position.x, y: maxY + 160 },
          selectable: false,
          data: { label: "Add reviewer", pending: rc.pending, onAddReviewer: rc.onAdd },
        });
      }
    }
    return mapped;
  }, [nodes, stepStatuses, labelOverrides, reviewerControls]);
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
  reviewerControls?: FlowReviewerControls,
): Node {
  const type = nodeTypeFor(n.kind);
  const label = overrides?.[n.id] ?? pickLabel(n);
  const subtitle = pickSubtitle(n);
  const status = statuses?.[n.id] ?? "idle";
  const data: Record<string, unknown> = { label, subtitle, status };
  if (reviewerControls?.reviewerIds.has(n.id)) {
    data.isReviewer = true;
    data.canDelete = reviewerControls.canDelete;
    data.pending = reviewerControls.pending;
    data.onDeleteReviewer = reviewerControls.onDelete;
  }
  return { id: n.id, type, position: n.position, data };
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
    case "github.pull_request_review":
      return "PR review submitted";
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
    case "github.pull_request_review":
      return "trigger";
    case "github.projects_v2_item": {
      // Compose `Status: Backlog → Ready` from from/to options. * for empty.
      const field = n.config?.fieldName ?? "Status";
      const fromList = n.config?.fromOptions ?? [];
      const toList = n.config?.toOptions ?? [];
      const fromStr = fromList.length === 0 ? "*" : fromList.join("|");
      const toStr = toList.length === 0 ? "*" : toList.join("|");
      return `${field}: ${fromStr} → ${toStr}`;
    }
    case "agent":
      // When the agent has a worktree option, show the branch
      // template instead of the (rarely-set) spec.command — the
      // branch is the more useful at-a-glance summary.
      return n.config?.worktree?.branchName ?? n.config?.spec?.command ?? undefined;
    case "github.post_review":
      return n.config?.event;
    case "github.add_label":
      return n.config?.labels?.join(", ");
    default:
      return undefined;
  }
}
