import { ExternalLink, Pencil, Play } from "lucide-react";
import { Link } from "react-router";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentPicker } from "@/components/agent/AgentPicker";
import { useTriggerImplementFlow, type KanbanItem } from "@/lib/queries";

const STATE_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  OPEN: "default",
  CLOSED: "secondary",
  MERGED: "outline",
};

/**
 * True when the GitHub issue url belongs to this opencara project's repo.
 * Used to scope the in-app Edit pencil — Projects v2 boards can include
 * issues from any repo, but /projects/:id/issues/:n on opencara only knows
 * about this project's repo.
 */
function isOwnRepoIssue(
  contentUrl: string | null,
  projectRepo: { owner: string; name: string } | null,
): boolean {
  if (!contentUrl || !projectRepo) return false;
  const expected = `https://github.com/${projectRepo.owner}/${projectRepo.name}/issues/`;
  return contentUrl.startsWith(expected);
}

export function KanbanCard({
  item,
  projectId,
  projectRepo,
  defaultImplementFlowSlug,
}: {
  item: KanbanItem;
  projectId: string;
  projectRepo: { owner: string; name: string } | null;
  defaultImplementFlowSlug: string | null;
}) {
  // Drag handle covers the whole card. The action icons (ExternalLink,
  // Pencil) stop pointerdown so they're clickable without starting a drag.
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id: item.githubItemNodeId });

  const state = item.contentState?.toUpperCase() ?? null;
  const stateLabel =
    item.kind === "draft"
      ? "draft"
      : state
        ? state.toLowerCase()
        : "—";
  const variant = state ? (STATE_VARIANT[state] ?? "secondary") : "outline";

  const style = {
    transform: CSS.Translate.toString(transform),
    opacity: isDragging ? 0.4 : undefined,
    cursor: isDragging ? "grabbing" : "grab",
  };

  const visibleLabels = item.labels.slice(0, 4);
  const extraLabelCount = item.labels.length - visibleLabels.length;

  const visibleAssignees = item.assignees.slice(0, 3);
  const extraAssigneeCount = item.assignees.length - visibleAssignees.length;

  const showImplementControls =
    item.kind === "issue" &&
    item.contentNumber !== null &&
    isOwnRepoIssue(item.contentUrl, projectRepo);

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="group touch-none rounded-md border bg-card p-3 shadow-sm transition-colors hover:bg-accent/40"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-snug">
            {item.contentTitle}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            {item.contentNumber !== null && <span>#{item.contentNumber}</span>}
            <Badge variant={variant} className="text-[10px] uppercase">
              {stateLabel}
            </Badge>
            {item.isArchived && (
              <Badge
                variant="outline"
                className="text-[10px] uppercase text-muted-foreground"
              >
                archived
              </Badge>
            )}
          </div>
          {visibleLabels.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {visibleLabels.map((l) => (
                <span
                  key={l.name}
                  className="rounded px-1.5 py-0.5 text-[10px] font-medium"
                  style={{
                    backgroundColor: `#${l.color}33`,
                    color: `#${l.color}`,
                    border: `1px solid #${l.color}66`,
                  }}
                >
                  {l.name}
                </span>
              ))}
              {extraLabelCount > 0 && (
                <span className="text-[10px] text-muted-foreground">
                  +{extraLabelCount}
                </span>
              )}
            </div>
          )}
          {visibleAssignees.length > 0 && (
            <div className="mt-2 flex items-center gap-1 text-[10px] text-muted-foreground">
              {visibleAssignees.map((a) => (
                <span key={a.id}>@{a.login}</span>
              ))}
              {extraAssigneeCount > 0 && (
                <span>+{extraAssigneeCount}</span>
              )}
            </div>
          )}
        </div>
        <div className="flex flex-col items-center gap-1">
          {item.kind === "issue" &&
            item.contentNumber !== null &&
            isOwnRepoIssue(item.contentUrl, projectRepo) && (
              <Link
                to={`/projects/${projectId}/issues/${item.contentNumber}`}
                className="text-muted-foreground hover:text-foreground"
                title="Edit in opencara"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <Pencil className="size-3.5" />
              </Link>
            )}
          {item.contentUrl && (
            <a
              href={item.contentUrl}
              target="_blank"
              rel="noreferrer"
              className="text-muted-foreground hover:text-foreground"
              title="Open on GitHub"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <ExternalLink className="size-3.5" />
            </a>
          )}
        </div>
      </div>
      {showImplementControls && (
        <div
          className="mt-2 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <AgentPicker
            projectId={projectId}
            issueNumber={item.contentNumber!}
            labels={item.labels}
            compact
          />
          <StartImplementButton
            projectId={projectId}
            issueNumber={item.contentNumber!}
            labels={item.labels}
            flowSlug={defaultImplementFlowSlug}
          />
        </div>
      )}
    </div>
  );
}

function StartImplementButton({
  projectId,
  issueNumber,
  labels,
  flowSlug,
}: {
  projectId: string;
  issueNumber: number;
  labels: { name: string; color: string }[];
  flowSlug: string | null;
}) {
  const trigger = useTriggerImplementFlow(projectId);
  const hasAgent = labels.some((l) => l.name.startsWith("agent:"));
  const disabled = !flowSlug || !hasAgent || trigger.isPending;

  const title = !flowSlug
    ? "Set a default implement flow in project settings first"
    : !hasAgent
      ? "Pick an agent first"
      : "Start implement flow for this issue";

  return (
    <Button
      variant="outline"
      size="sm"
      className="h-6 px-2 text-[10px]"
      disabled={disabled}
      title={title}
      onClick={() => {
        if (!flowSlug) return;
        trigger.mutate({ slug: flowSlug, issueNumber });
      }}
    >
      <Play className="mr-1 size-3" />
      {trigger.isPending ? "Starting…" : "Start"}
    </Button>
  );
}
