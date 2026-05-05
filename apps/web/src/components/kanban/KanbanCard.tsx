import { ExternalLink } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { KanbanItem } from "@/lib/queries";

const STATE_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  OPEN: "default",
  CLOSED: "secondary",
  MERGED: "outline",
};

export function KanbanCard({ item }: { item: KanbanItem }) {
  const state = item.contentState?.toUpperCase() ?? null;
  const stateLabel =
    item.kind === "draft"
      ? "draft"
      : state
        ? state.toLowerCase()
        : "—";
  const variant = state ? (STATE_VARIANT[state] ?? "secondary") : "outline";

  return (
    <div className="rounded-md border bg-card p-3 shadow-sm transition-colors hover:bg-accent/40">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-snug">
            {item.contentTitle}
          </div>
          <div className="mt-1 flex items-center gap-2 text-xs text-muted-foreground">
            {item.contentNumber !== null && <span>#{item.contentNumber}</span>}
            <Badge variant={variant} className="text-[10px] uppercase">
              {stateLabel}
            </Badge>
          </div>
        </div>
        {item.contentUrl && (
          <a
            href={item.contentUrl}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground"
            title="Open on GitHub"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
    </div>
  );
}
