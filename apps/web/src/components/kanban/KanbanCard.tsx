import { ExternalLink } from "lucide-react";
import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
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
  // Drag handle covers the whole card. The ExternalLink anchor inside has
  // its own click handler; the DndContext's PointerSensor activationDistance
  // (5px) keeps small clicks from being mistaken for drags.
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

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="touch-none rounded-md border bg-card p-3 shadow-sm transition-colors hover:bg-accent/40"
    >
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
            // Stop the pointerdown from reaching the drag listeners — without
            // this the icon never gets a clean click because the sensor
            // grabs every pointerdown on the card.
            onPointerDown={(e) => e.stopPropagation()}
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </div>
    </div>
  );
}
