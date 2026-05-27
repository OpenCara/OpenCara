import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import {
  kanbanQuery,
  useKanbanStream,
  useSetItemStatus,
  type KanbanStatusOption,
} from "@/lib/queries";

// Sentinel option id for "No status" — Radix Select cannot use an empty string
// as a value, so we map null ↔ this constant at the boundary. Matches the
// pattern used by KanbanBoard for its no-status column.
const NO_STATUS_VALUE = "__none";

/**
 * Project status dropdown for the issue editing page. Shows the issue's
 * current Projects v2 Status field and lets the user change it in place
 * (mirrors the kanban board's drag-between-columns interaction).
 *
 * Renders nothing when:
 *   - the project has no Projects v2 board linked, or
 *   - the issue isn't on the linked board (e.g. a brand-new issue webhook
 *     hasn't reached the kanban mirror yet — refreshing the kanban tab will
 *     pull it in).
 *
 * Matching by `issueHtmlUrl` (the issue's GitHub URL) rather than just the
 * issue number — Projects v2 boards are multi-repo, so two repos can each
 * contribute an `#N` to the same board; the URL is the only repo-scoped key
 * available on a cached board item.
 */
export function IssueStatusDropdown({
  projectId,
  issueHtmlUrl,
}: {
  projectId: string;
  issueHtmlUrl: string;
}) {
  const q = useQuery(kanbanQuery(projectId));
  // Keep the cached snapshot fresh while this page is open. Webhook-driven
  // status changes (someone else moves the card on GitHub) reconcile here
  // without a manual refetch.
  useKanbanStream(projectId);
  const setStatus = useSetItemStatus(projectId);

  const item = useMemo(
    () =>
      q.data?.items.find(
        (it) => it.kind === "issue" && it.contentUrl === issueHtmlUrl,
      ) ?? null,
    [q.data, issueHtmlUrl],
  );

  const orderedColumns: KanbanStatusOption[] = useMemo(() => {
    return [...(q.data?.columns ?? [])].sort((a, b) => a.position - b.position);
  }, [q.data]);

  if (q.isLoading) {
    return <Skeleton className="mt-3 h-8 w-40" />;
  }
  // Board not linked, or this issue isn't mirrored on the board. Either way
  // there's nothing the dropdown can act on, so hide it rather than render a
  // disabled control that just sits there confusingly.
  if (!q.data?.link || !item) return null;

  const value = item.statusOptionId ?? NO_STATUS_VALUE;

  const onValueChange = (next: string) => {
    const statusOptionId = next === NO_STATUS_VALUE ? null : next;
    if (statusOptionId === item.statusOptionId) return;
    setStatus.mutate({
      itemNodeId: item.githubItemNodeId,
      statusOptionId,
    });
  };

  return (
    <div className="mt-3 flex items-center gap-2 text-xs">
      <span className="uppercase tracking-wide text-muted-foreground">
        Status
      </span>
      <Select
        value={value}
        onValueChange={onValueChange}
        // Drop the stale "failed" pill when the user re-engages the control —
        // otherwise a one-off PATCH failure stays pinned to the header until
        // the next Status change, even though it no longer reflects reality.
        onOpenChange={(open) => {
          if (open && setStatus.isError) setStatus.reset();
        }}
      >
        <SelectTrigger size="sm" className="h-7 text-xs">
          <SelectValue placeholder="No status">
            <StatusDot
              color={
                orderedColumns.find((c) => c.optionId === item.statusOptionId)
                  ?.color ?? "GRAY"
              }
            />
            <span>
              {orderedColumns.find((c) => c.optionId === item.statusOptionId)
                ?.name ?? "No status"}
            </span>
          </SelectValue>
        </SelectTrigger>
        <SelectContent>
          {orderedColumns.map((c) => (
            <SelectItem key={c.optionId} value={c.optionId}>
              <StatusDot color={c.color} />
              <span>{c.name}</span>
            </SelectItem>
          ))}
          <SelectItem value={NO_STATUS_VALUE}>
            <StatusDot color="GRAY" />
            <span>No status</span>
          </SelectItem>
        </SelectContent>
      </Select>
      {setStatus.error && (
        <span
          className="text-xs text-destructive"
          title={
            setStatus.error instanceof Error
              ? setStatus.error.message
              : String(setStatus.error)
          }
        >
          failed
        </span>
      )}
    </div>
  );
}

function StatusDot({ color }: { color: string }) {
  return (
    <span
      className="size-2 rounded-full"
      style={{ backgroundColor: colorHex(color) }}
      aria-hidden
    />
  );
}

// Mirrors KanbanBoard.colorHex — GitHub returns Projects v2 single-select
// colors as enum names rather than hex codes.
function colorHex(c: string): string {
  switch (c) {
    case "GRAY":
      return "#6e7781";
    case "RED":
      return "#e5534b";
    case "ORANGE":
      return "#f0883e";
    case "YELLOW":
      return "#d4a72c";
    case "GREEN":
      return "#347d39";
    case "BLUE":
      return "#0969da";
    case "PURPLE":
      return "#8250df";
    case "PINK":
      return "#bf3989";
    default:
      return "#6e7781";
  }
}
