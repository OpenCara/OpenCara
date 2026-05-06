import type { NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import {
  Webhook,
  Bot,
  Send,
  Tag,
  MessageCircle,
  GitBranch,
  GitPullRequest,
  type LucideIcon,
} from "lucide-react";
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
}

interface BaseProps {
  data: NodeData;
  icon: LucideIcon;
  hasIn?: boolean;
  hasOut?: boolean;
}

function BaseNode({ data, icon: Icon, hasIn = true, hasOut = true }: BaseProps) {
  const status: StepStatus | "idle" = data.status ?? "idle";
  return (
    <div
      className={cn(
        "flex w-56 items-center gap-3 rounded-md border bg-card p-3 shadow-sm",
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
    </div>
  );
}

export function TriggerNode({ data }: NodeProps) {
  return <BaseNode data={data as NodeData} icon={Webhook} hasIn={false} />;
}
export function AgentNode({ data }: NodeProps) {
  return <BaseNode data={data as NodeData} icon={Bot} />;
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
export function CreateWorktreeNode({ data }: NodeProps) {
  return <BaseNode data={data as NodeData} icon={GitBranch} />;
}
export function CreatePRNode({ data }: NodeProps) {
  // Terminal: opens a PR and exposes nothing further to chain.
  return <BaseNode data={data as NodeData} icon={GitPullRequest} hasOut={false} />;
}

export const flowNodeTypes = {
  trigger: TriggerNode,
  agent: AgentNode,
  postReview: PostReviewNode,
  addComment: AddCommentNode,
  addLabel: AddLabelNode,
  createWorktree: CreateWorktreeNode,
  createPR: CreatePRNode,
};
