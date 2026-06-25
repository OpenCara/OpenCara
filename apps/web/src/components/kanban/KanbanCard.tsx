import {
  AlertCircle,
  CircleSlash,
  Clock,
  ExternalLink,
  GitPullRequest,
  GitPullRequestArrow,
  Loader2,
  Pencil,
  Play,
} from "lucide-react";
import { Link } from "react-router";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentPicker } from "@/components/agent/AgentPicker";
import { PromptPicker } from "@/components/agent/PromptPicker";
import {
  useTriggerImplementFlow,
  type KanbanImplementStatus,
  type KanbanItem,
  type KanbanLinkedPr,
  type KanbanPrFlowStatus,
} from "@/lib/queries";

const STATE_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  OPEN: "default",
  CLOSED: "secondary",
  MERGED: "outline",
};

const PR_STATE_COLOR: Record<string, string> = {
  OPEN: "text-green-600",
  DRAFT: "text-muted-foreground",
  CLOSED: "text-red-500",
  MERGED: "text-purple-600",
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
  defaultAgentName,
  defaultPromptName,
}: {
  item: KanbanItem;
  projectId: string;
  projectRepo: { owner: string; name: string } | null;
  defaultImplementFlowSlug: string | null;
  /** Project default implement agent/prompt names (#158). Pre-populate the
   *  card dropdowns when the issue carries no `agent:` / `prompt:` override
   *  label; null when the project has no such default. */
  defaultAgentName: string | null;
  defaultPromptName: string | null;
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

  // When dragging, the DragOverlay renders the visual card at the pointer.
  // This element stays in place as a translucent placeholder so the column
  // layout is preserved and no overflow clipping / column expansion occurs.
  const style = {
    transform: isDragging ? undefined : CSS.Translate.toString(transform),
    opacity: isDragging ? 0.3 : undefined,
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
          {item.implementStatus && (
            <ImplementStatusLine
              status={item.implementStatus}
              projectId={projectId}
            />
          )}
          {item.linkedPrs?.length > 0 && (
            <div className="mt-2 flex flex-col gap-1">
              {item.linkedPrs.map((pr) => (
                <LinkedPrBadge key={pr.number} pr={pr} />
              ))}
            </div>
          )}
          {item.prFlowStatus && (
            <PrFlowStatusLine
              status={item.prFlowStatus}
              projectId={projectId}
            />
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
          className="mt-2 space-y-1.5"
          onPointerDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center gap-1.5">
            <div className="min-w-0 flex-1">
              <AgentPicker
                projectId={projectId}
                issueNumber={item.contentNumber!}
                labels={item.labels}
                compact
                defaultAgentName={defaultAgentName}
              />
            </div>
            <div className="min-w-0 flex-1">
              <PromptPicker
                projectId={projectId}
                issueNumber={item.contentNumber!}
                labels={item.labels}
                compact
                defaultPromptName={defaultPromptName}
              />
            </div>
          </div>
          <StartImplementButton
            projectId={projectId}
            issueNumber={item.contentNumber!}
            labels={item.labels}
            flowSlug={defaultImplementFlowSlug}
            hasDefaultAgent={defaultAgentName !== null}
          />
        </div>
      )}
    </div>
  );
}

/**
 * One-line agent status surfaced on issue cards. Renders nothing for
 * succeeded runs (those don't reach the client — the linked-PR badge
 * communicates the same outcome) and uses a spinner for in-flight states
 * so the at-a-glance signal is obvious without reading the text.
 *
 * The whole line is a Link to the flow-run detail page so the user can
 * jump straight to the agent's live output without hunting through the
 * Flow Runs tab. `onPointerDown` stops the drag handler from claiming
 * the click.
 */
function ImplementStatusLine({
  status,
  projectId,
}: {
  status: KanbanImplementStatus;
  projectId: string;
}) {
  const presentation = STATUS_PRESENTATION[status.state];
  const Icon = presentation.icon;
  return (
    <Link
      to={`/projects/${projectId}/flow-runs/${status.flowRunId}`}
      className={`mt-2 flex items-center gap-1 text-[10px] hover:underline ${presentation.color}`}
      title={`Open flow run ${status.flowRunId.slice(-8)} · ${status.state}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <Icon
        className={`size-3 shrink-0 ${presentation.spin ? "animate-spin" : ""}`}
      />
      <span className="truncate">{status.label}</span>
    </Link>
  );
}

const STATUS_PRESENTATION: Record<
  KanbanImplementStatus["state"],
  {
    icon: typeof Loader2;
    color: string;
    /** Whether to apply the spin animation to the icon. */
    spin: boolean;
  }
> = {
  pending: { icon: Clock, color: "text-muted-foreground", spin: false },
  running: { icon: Loader2, color: "text-blue-600", spin: true },
  failed: { icon: AlertCircle, color: "text-destructive", spin: false },
  cancelled: { icon: CircleSlash, color: "text-muted-foreground", spin: false },
};

/**
 * Inline indicator surfaced on an issue card while one of its linked PRs has
 * an active PR-review flow run (#160). The whole line links to the flow-run
 * detail page. Uses a spinner while running and a clock while queued so the
 * at-a-glance "review in progress" signal reads without parsing the text.
 * Styled violet to set it apart from the blue implement-status line and the
 * PR-state colours on the linked-PR badges.
 */
function PrFlowStatusLine({
  status,
  projectId,
}: {
  status: KanbanPrFlowStatus;
  projectId: string;
}) {
  const spin = status.state === "running";
  const Icon = spin ? Loader2 : Clock;
  return (
    <Link
      to={`/projects/${projectId}/flow-runs/${status.flowRunId}`}
      className="mt-2 flex items-center gap-1 text-[10px] text-violet-600 hover:underline"
      title={`PR #${status.prNumber} · ${status.label}${status.state === "pending" ? " (queued)" : ""}`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <GitPullRequestArrow className="size-3 shrink-0" />
      <Icon className={`size-3 shrink-0 ${spin ? "animate-spin" : ""}`} />
      <span className="truncate">{status.label}</span>
    </Link>
  );
}

function LinkedPrBadge({ pr }: { pr: KanbanLinkedPr }) {
  const colorClass = PR_STATE_COLOR[pr.state] ?? "text-muted-foreground";
  return (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
      title={`${pr.title} (${pr.state.toLowerCase()})`}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <GitPullRequest className={`size-3 shrink-0 ${colorClass}`} />
      <span className="truncate">#{pr.number}</span>
      <span className={`uppercase ${colorClass}`}>{pr.state.toLowerCase()}</span>
    </a>
  );
}

function StartImplementButton({
  projectId,
  issueNumber,
  labels,
  flowSlug,
  hasDefaultAgent,
}: {
  projectId: string;
  issueNumber: number;
  labels: { name: string; color: string }[];
  flowSlug: string | null;
  /** True when the project sets a default implement agent — the issue can
   *  then dispatch with the inherited default even without an `agent:` label. */
  hasDefaultAgent: boolean;
}) {
  const trigger = useTriggerImplementFlow(projectId);
  // An effective agent is either a per-card `agent:<name>` override label or
  // the inherited project default — dispatch resolves the same precedence.
  const hasAgent =
    labels.some((l) => l.name.startsWith("agent:")) || hasDefaultAgent;
  const disabled = !flowSlug || !hasAgent || trigger.isPending;

  const title = !flowSlug
    ? "Set a default implement flow in project settings first"
    : !hasAgent
      ? "Pick an agent first (or set a default in project settings)"
      : "Start implement flow for this issue";

  return (
    <span className="inline-flex items-center gap-1">
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
      {trigger.error && (
        <span className="text-[10px] text-destructive" title={trigger.error instanceof Error ? trigger.error.message : String(trigger.error)}>
          failed
        </span>
      )}
    </span>
  );
}

/** Presentational card rendered inside the DragOverlay portal. */
export function KanbanCardOverlay({
  item,
  projectId,
}: {
  item: KanbanItem;
  projectId: string;
}) {
  const state = item.contentState?.toUpperCase() ?? null;
  const stateLabel =
    item.kind === "draft"
      ? "draft"
      : state
        ? state.toLowerCase()
        : "—";
  const variant = state ? (STATE_VARIANT[state] ?? "secondary") : "outline";
  const visibleLabels = item.labels.slice(0, 4);
  const extraLabelCount = item.labels.length - visibleLabels.length;

  // Width matches the Column card area: w-72 (288px) minus p-2 padding (16px).
  return (
    <div className="w-[272px] rounded-md border bg-card p-3 shadow-lg">
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
      {item.implementStatus && (
        <ImplementStatusLine
          status={item.implementStatus}
          projectId={projectId}
        />
      )}
      {item.linkedPrs?.length > 0 && (
        <div className="mt-2 flex flex-col gap-1">
          {item.linkedPrs.map((pr) => (
            <div
              key={pr.number}
              className="flex items-center gap-1 text-[10px] text-muted-foreground"
            >
              <GitPullRequest
                className={`size-3 shrink-0 ${PR_STATE_COLOR[pr.state] ?? "text-muted-foreground"}`}
              />
              <span>#{pr.number}</span>
              <span className={PR_STATE_COLOR[pr.state] ?? "text-muted-foreground"}>
                {pr.state.toLowerCase()}
              </span>
            </div>
          ))}
        </div>
      )}
      {item.prFlowStatus &&
        (() => {
          // Match PrFlowStatusLine: spinner while running, clock while queued.
          const spin = item.prFlowStatus.state === "running";
          const Icon = spin ? Loader2 : Clock;
          return (
            <div className="mt-2 flex items-center gap-1 text-[10px] text-violet-600">
              <GitPullRequestArrow className="size-3 shrink-0" />
              <Icon className={`size-3 shrink-0 ${spin ? "animate-spin" : ""}`} />
              <span className="truncate">{item.prFlowStatus.label}</span>
            </div>
          );
        })()}
    </div>
  );
}
