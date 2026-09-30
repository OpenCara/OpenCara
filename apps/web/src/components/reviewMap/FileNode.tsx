import { memo } from "react";
import { Handle, Position, type Node, type NodeProps } from "@xyflow/react";
import {
  FILE_NODE_HEIGHT,
  FILE_NODE_WIDTH,
  type ReviewMapFile,
  type ReviewMapSeverity,
} from "@opencara/shared";
import { cn } from "@/lib/utils";

export interface FileNodeData extends Record<string, unknown> {
  file: ReviewMapFile;
  selected: boolean;
  dimmed: boolean;
  /** Neighbour of the selected/hovered node. */
  neighbor: boolean;
  /** Matches the toolbar search. */
  matched: boolean;
}

export type ReviewMapFileNode = Node<FileNodeData, "file">;

const STRIPE: Record<ReviewMapFile["status"], string> = {
  added: "bg-emerald-600",
  modified: "bg-blue-600",
  removed: "bg-red-600",
  renamed: "bg-violet-600",
};

const SEVERITY_BADGE: Record<ReviewMapSeverity, string> = {
  high: "bg-red-600",
  medium: "bg-orange-600",
  low: "bg-yellow-500",
  info: "bg-muted-foreground",
};

const SEVERITY_RANK: Record<ReviewMapSeverity, number> = {
  high: 3,
  medium: 2,
  low: 1,
  info: 0,
};

function baseOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

function worstSeverity(f: ReviewMapFile): ReviewMapSeverity | null {
  let best: ReviewMapSeverity | null = null;
  for (const fnd of f.findings) {
    if (!best || SEVERITY_RANK[fnd.severity] > SEVERITY_RANK[best]) best = fnd.severity;
  }
  return best;
}

/** One changed file, styled to match the SVG snapshot's node card. */
export const FileNode = memo(function FileNode({
  data,
}: NodeProps<ReviewMapFileNode>) {
  const { file, selected, dimmed, neighbor, matched } = data;
  const sev = worstSeverity(file);
  return (
    <div
      title={file.path}
      className={cn(
        "relative rounded-md border bg-card text-left shadow-xs transition-opacity",
        selected
          ? "border-primary ring-2 ring-primary/40"
          : neighbor
            ? "border-primary/50"
            : "border-border",
        matched && "ring-2 ring-yellow-400/70",
        dimmed && "opacity-30",
        file.status === "removed" && "opacity-60",
      )}
      style={{ width: FILE_NODE_WIDTH, height: FILE_NODE_HEIGHT }}
    >
      {/* Four hidden handles so edges can attach to the correct side per
          edgeSides() — same-column edges loop out and back into the right. */}
      <Handle type="target" id="l" position={Position.Left} className="!opacity-0" />
      <Handle type="target" id="r" position={Position.Right} className="!opacity-0" />
      <Handle type="source" id="l" position={Position.Left} className="!opacity-0" />
      <Handle type="source" id="r" position={Position.Right} className="!opacity-0" />
      <div
        className={cn(
          "absolute inset-y-1 left-1 w-1 rounded-full",
          STRIPE[file.status],
        )}
      />
      <div className="flex h-full flex-col justify-center gap-0.5 pl-3.5 pr-2">
        <div className="flex items-center gap-1.5">
          <span className="truncate text-xs font-medium">{baseOf(file.path)}</span>
          {sev && (
            <span
              className={cn(
                "ml-auto flex h-4 min-w-5 items-center justify-center rounded-full px-1 text-[10px] font-bold text-white",
                SEVERITY_BADGE[sev],
              )}
            >
              {file.findings.length}
            </span>
          )}
        </div>
        <div className="text-[10px] text-muted-foreground">
          <span className="text-emerald-600">+{file.additions}</span>{" "}
          <span className="text-red-600">−{file.deletions}</span>
        </div>
      </div>
    </div>
  );
});
