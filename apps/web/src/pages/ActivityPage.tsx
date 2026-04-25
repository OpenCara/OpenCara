import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { activityQuery, type ActivityItem } from "@/lib/queries";
import { formatRelative, formatDayHeader } from "@/lib/format";
import { summarizeEvent } from "@/lib/eventSummary";

export function ActivityPage() {
  const q = useQuery(activityQuery());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Activity</h1>
        <p className="text-sm text-muted-foreground">
          Recent events and agent runs across your projects.
        </p>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-medium text-muted-foreground">
            Timeline
          </CardTitle>
        </CardHeader>
        <CardContent>
          {q.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : !q.data || q.data.activity.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No activity yet.
            </div>
          ) : (
            <Timeline items={q.data.activity} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Timeline({ items }: { items: ActivityItem[] }) {
  const groups = groupByDay(items);
  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.day}>
          <h3 className="sticky top-0 mb-2 bg-card pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {formatDayHeader(group.day)}
          </h3>
          <ul className="space-y-1.5">
            {group.items.map((it) => (
              <li
                key={`${it.kind}-${it.id}`}
                className="flex items-start gap-3 rounded-md px-2 py-1.5 hover:bg-secondary/40"
              >
                <span className="w-20 shrink-0 text-xs text-muted-foreground">
                  {formatRelative(it.ts)}
                </span>
                <Badge variant={it.kind === "run" ? "outline" : "secondary"}>
                  {it.kind}
                </Badge>
                <span className="text-sm">
                  {it.kind === "event"
                    ? summarizeEvent(it.type, it.payload)
                    : `agent run ${it.type}`}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function groupByDay(items: ActivityItem[]): { day: string; items: ActivityItem[] }[] {
  const buckets = new Map<string, ActivityItem[]>();
  for (const it of items) {
    const day = new Date(it.ts).toDateString();
    const arr = buckets.get(day) ?? [];
    arr.push(it);
    buckets.set(day, arr);
  }
  return Array.from(buckets.entries()).map(([day, items]) => ({ day, items }));
}
