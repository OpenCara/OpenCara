import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { ExternalLink, RefreshCw, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  kanbanQuery,
  useRefreshKanban,
  useUnlinkKanban,
  type KanbanBoardData,
  type KanbanItem,
  type KanbanStatusOption,
} from "@/lib/queries";
import { formatRelative } from "@/lib/format";
import { KanbanCard } from "./KanbanCard";
import { KanbanLinkPicker } from "./KanbanLinkPicker";

export function KanbanTab({ projectId }: { projectId: string }) {
  const q = useQuery(kanbanQuery(projectId));
  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (q.error) {
    return (
      <div className="text-sm text-destructive">
        Failed to load board:{" "}
        {q.error instanceof Error ? q.error.message : String(q.error)}
      </div>
    );
  }
  const data = q.data;
  if (!data || !data.link) {
    return <KanbanLinkPicker projectId={projectId} />;
  }
  return <LinkedBoard projectId={projectId} data={data} />;
}

function LinkedBoard({
  projectId,
  data,
}: {
  projectId: string;
  data: KanbanBoardData;
}) {
  const refresh = useRefreshKanban(projectId);
  const unlink = useUnlinkKanban(projectId);
  const link = data.link!;

  // Group items by status_option_id. Items with a null/unknown option go into
  // a synthetic "No status" column so they're still visible — Projects v2
  // happily lets items have no Status set.
  const grouped = useMemo(() => {
    const map = new Map<string | null, KanbanItem[]>();
    for (const it of data.items) {
      const key = it.statusOptionId;
      const list = map.get(key) ?? [];
      list.push(it);
      map.set(key, list);
    }
    // Sort within each column by updatedAt desc (newest first).
    for (const list of map.values()) {
      list.sort((a, b) =>
        a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0,
      );
    }
    return map;
  }, [data.items]);

  const orderedColumns: KanbanStatusOption[] = useMemo(() => {
    return [...data.columns].sort((a, b) => a.position - b.position);
  }, [data.columns]);

  const noStatusItems = grouped.get(null) ?? [];

  // Canonical Projects v2 URL differs by owner type — orgs live under /orgs/,
  // user-owned boards under /users/. The flat /{owner}/projects/N form 404s.
  const githubBoardUrl =
    link.githubProjectOwnerType === "User"
      ? `https://github.com/users/${link.githubProjectOwner}/projects/${link.githubProjectNumber}`
      : `https://github.com/orgs/${link.githubProjectOwner}/projects/${link.githubProjectNumber}`;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-base font-medium">{link.githubProjectTitle}</div>
          <div className="text-xs text-muted-foreground">
            @{link.githubProjectOwner} · #{link.githubProjectNumber}
            {link.lastSyncedAt && (
              <> · synced {formatRelative(link.lastSyncedAt)}</>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <a
            href={githubBoardUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground"
            title="Open on GitHub"
          >
            <ExternalLink className="size-4" />
          </a>
          <Button
            variant="outline"
            size="sm"
            disabled={refresh.isPending}
            onClick={() => refresh.mutate()}
          >
            <RefreshCw
              className={`mr-1 size-3.5 ${refresh.isPending ? "animate-spin" : ""}`}
            />
            {refresh.isPending ? "Refreshing…" : "Refresh"}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={unlink.isPending}
            onClick={() => {
              if (window.confirm("Unlink this board? Items will be removed from the local mirror.")) {
                unlink.mutate();
              }
            }}
          >
            <Unlink className="mr-1 size-3.5" />
            Unlink
          </Button>
        </div>
      </div>

      {refresh.error && (
        <div className="text-xs text-destructive">
          Refresh failed:{" "}
          {refresh.error instanceof Error
            ? refresh.error.message
            : String(refresh.error)}
        </div>
      )}

      {orderedColumns.length === 0 ? (
        <div className="rounded-md border bg-muted/30 p-6 text-sm text-muted-foreground">
          This board has no Status field options. Add some on GitHub and click
          Refresh.
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {orderedColumns.map((col) => (
            <Column
              key={col.optionId}
              option={col}
              items={grouped.get(col.optionId) ?? []}
            />
          ))}
          {noStatusItems.length > 0 && (
            <Column
              option={{
                optionId: "__none",
                name: "No status",
                color: "GRAY",
                position: 999,
              }}
              items={noStatusItems}
            />
          )}
        </div>
      )}
    </div>
  );
}

function Column({
  option,
  items,
}: {
  option: KanbanStatusOption;
  items: KanbanItem[];
}) {
  return (
    <div className="flex w-72 shrink-0 flex-col rounded-md border bg-muted/30">
      <div className="flex items-center justify-between border-b bg-background/50 px-3 py-2">
        <div className="flex items-center gap-2">
          <span
            className="size-2 rounded-full"
            style={{ backgroundColor: colorHex(option.color) }}
            aria-hidden
          />
          <span className="text-sm font-medium">{option.name}</span>
        </div>
        <span className="text-xs text-muted-foreground">{items.length}</span>
      </div>
      <div className="flex flex-col gap-2 p-2">
        {items.length === 0 ? (
          <div className="px-1 py-6 text-center text-xs text-muted-foreground">
            Empty
          </div>
        ) : (
          items.map((it) => <KanbanCard key={it.id} item={it} />)
        )}
      </div>
    </div>
  );
}

// Map GitHub's Projects v2 single-select color names to hex. The GraphQL API
// returns an enum value (GRAY, RED, ORANGE, YELLOW, GREEN, BLUE, PURPLE, PINK)
// rather than an actual hex code, so the UI has to do the lookup.
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
