import type { ReactNode } from "react";
import type { NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import { Webhook, Bot, Send, Tag, MessageCircle, Plus, X, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type StepStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

const statusRing: Record<StepStatus | "idle", string> = {
  idle: "ring-1 ring-border",
  pending: "ring-1 ring-border",
  running: "ring-2 ring-blue-400 animate-pulse",
  succeeded: "ring-2 ring-emerald-500",
  failed: "ring-2 ring-destructive",
  skipped: "ring-1 ring-amber-400",
};

interface NodeData extends Record<string, unknown> {
  label: string;
  subtitle?: string;
  status?: StepStatus | "idle";
  // Reviewer-management extras, set by FlowGraph only on the editable flow
  // canvas (absent in the read-only run view, so no controls render there).
  isReviewer?: boolean;
  canDelete?: boolean;
  pending?: boolean;
  onDeleteReviewer?: (id: string) => void;
  onAddReviewer?: () => void;
}

interface BaseProps {
  data: NodeData;
  icon: LucideIcon;
  hasIn?: boolean;
  hasOut?: boolean;
  /** Optional overlay (e.g. a delete button), positioned by the caller. */
  action?: ReactNode;
}

function BaseNode({ data, icon: Icon, hasIn = true, hasOut = true, action }: BaseProps) {
  const status: StepStatus | "idle" = data.status ?? "idle";
  return (
    <div
      className={cn(
        "relative flex w-56 items-center gap-3 rounded-md border bg-card p-3 shadow-sm",
        statusRing[status],
      )}
    >
      {hasIn && <Handle type="target" position={Position.Left} />}
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-secondary">
        <Icon className="size-4 text-secondary-foreground" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium">{data.label}</div>
        {data.subtitle && (
          <div className="truncate text-xs text-muted-foreground">{data.subtitle}</div>
        )}
      </div>
      {hasOut && <Handle type="source" position={Position.Right} />}
      {action}
    </div>
  );
}

export function TriggerNode({ data }: NodeProps) {
  return <BaseNode data={data as NodeData} icon={Webhook} hasIn={false} />;
}
export function AgentNode({ id, data }: NodeProps) {
  const d = data as NodeData;
  const deletable = d.isReviewer && d.canDelete;
  return (
    <BaseNode
      data={d}
      icon={Bot}
      action={
        deletable ? (
          <button
            type="button"
            className="nodrag nopan absolute -right-2 -top-2 flex size-5 items-center justify-center rounded-full border bg-background text-muted-foreground shadow-sm hover:border-destructive hover:bg-destructive hover:text-destructive-foreground disabled:pointer-events-none disabled:opacity-40"
            disabled={d.pending}
            title="Remove this reviewer"
            onClick={(e) => {
              e.stopPropagation();
              d.onDeleteReviewer?.(id);
            }}
          >
            <X className="size-3" />
          </button>
        ) : undefined
      }
    />
  );
}
export function PostReviewNode({ data }: NodeProps) {
  return <BaseNode data={data as NodeData} icon={Send} hasOut={false} />;
}
export function AddCommentNode({ data }: NodeProps) {
  return <BaseNode data={data as NodeData} icon={MessageCircle} hasOut={false} />;
}
export function AddLabelNode({ data }: NodeProps) {
  return <BaseNode data={data as NodeData} icon={Tag} hasOut={false} />;
}

/**
 * A synthetic "+" node placed in the gap between the PR trigger and the
 * reviewer column on the editable flow canvas. Not a real graph node —
 * clicking it calls the add-reviewer mutation, which inserts a real reviewer
 * wired trigger → reviewer → synthesizer.
 */
export function AddReviewerNode({ data }: NodeProps) {
  const d = data as NodeData;
  return (
    <button
      type="button"
      className="nodrag nopan flex size-8 items-center justify-center rounded-full border border-dashed bg-card/40 text-muted-foreground shadow-sm transition-colors hover:border-primary hover:text-primary disabled:pointer-events-none disabled:opacity-50"
      disabled={d.pending}
      title="Add a reviewer to this review stage"
      onClick={(e) => {
        e.stopPropagation();
        d.onAddReviewer?.();
      }}
    >
      <Plus className="size-4" />
    </button>
  );
}

export const flowNodeTypes = {
  trigger: TriggerNode,
  agent: AgentNode,
  postReview: PostReviewNode,
  addComment: AddCommentNode,
  addLabel: AddLabelNode,
  addReviewer: AddReviewerNode,
};
