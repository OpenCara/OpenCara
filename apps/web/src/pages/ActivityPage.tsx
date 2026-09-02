import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  activityQuery,
  type ActivityItem,
  type ActivityRunPayload,
  type ActivitySubject,
} from "@/lib/queries";
import { formatRelative, formatAbsolute, formatDayHeader } from "@/lib/format";
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
              <TimelineRow key={`${it.kind}-${it.id}`} item={it} />
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function TimelineRow({ item }: { item: ActivityItem }) {
  const isRun = item.kind === "run";
  const run = isRun ? (item.payload as ActivityRunPayload) : null;
  const projectId = item.project?.id ?? item.project_id;
  // The subject link already carries "PR #12 · Title", so drop the same
  // "PR #12 " / "Issue #12 " prefix from the event summary to avoid
  // printing the number twice on one line.
  const headline = isRun
    ? `${item.agentKind ?? "agent"} run ${item.type}`
    : item.subject
      ? summarizeEvent(item.type, item.payload).replace(/^(PR|Issue|WI) #\d+ /, "")
      : summarizeEvent(item.type, item.payload);
  const duration = run ? formatDuration(run.startedAt, run.finishedAt) : "";

  return (
    <li className="flex items-start gap-3 rounded-md px-2 py-1.5 hover:bg-secondary/40">
      <span
        className="w-20 shrink-0 pt-0.5 text-xs text-muted-foreground"
        title={formatAbsolute(item.ts)}
      >
        {formatRelative(item.ts)}
      </span>
      <Badge variant={isRun ? statusVariant(item.type) : "secondary"} className="shrink-0">
        {item.type}
      </Badge>
      <div className="min-w-0 flex-1 space-y-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <span>{headline}</span>
          {item.subject && <SubjectLink subject={item.subject} projectId={projectId} />}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
          {item.project && (
            <Link to={`/projects/${item.project.id}`} className="hover:underline">
              {item.project.owner}/{item.project.name}
            </Link>
          )}
          {item.flow && projectId && (
            <Link
              to={`/projects/${projectId}/flows/${item.flow.slug}`}
              className="hover:underline"
            >
              flow: {item.flow.name}
            </Link>
          )}
          {item.flowRunId && projectId && (
            <Link
              to={`/projects/${projectId}/flow-runs/${item.flowRunId}`}
              className="hover:underline"
            >
              run {item.flowRunId.slice(-8)}
            </Link>
          )}
          {item.nodeId && <span>node: {item.nodeId}</span>}
          {run?.hostId && <span>host: {run.hostId}</span>}
          {run && run.exitCode != null && <span>exit {run.exitCode}</span>}
          {duration && <span>{duration}</span>}
          {run?.cancelReason && <span>cancelled: {run.cancelReason}</span>}
        </div>
        {item.triggeredRuns.length > 0 && projectId && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>triggered:</span>
            {item.triggeredRuns.map((tr) => (
              <span key={tr.id} className="inline-flex items-center gap-1">
                <Link
                  to={`/projects/${projectId}/flow-runs/${tr.id}`}
                  className="hover:underline"
                >
                  {tr.flow.name}
                </Link>
                <Badge variant={statusVariant(tr.status)} className="px-1.5 py-0 text-[10px]">
                  {tr.status}
                </Badge>
              </span>
            ))}
          </div>
        )}
      </div>
    </li>
  );
}

/**
 * GitHub issues have an in-app detail page, so they link there with an
 * extra external icon for the platform page. PRs, pushes and Azure DevOps
 * work items (the issues table is GitHub-only) link to the platform.
 */
function SubjectLink({
  subject,
  projectId,
}: {
  subject: ActivitySubject;
  projectId: string | null;
}) {
  const text = subject.title ? `${subject.label} · ${subject.title}` : subject.label;
  const internal =
    subject.kind === "issue" && projectId && subject.number != null
      ? `/projects/${projectId}/issues/${subject.number}`
      : null;
  const cls = "inline-flex max-w-md items-center gap-1 truncate font-medium hover:underline";
  if (internal) {
    return (
      <span className="inline-flex items-center gap-1">
        <Link to={internal} className={cls} title={text}>
          {text}
        </Link>
        {subject.url && (
          <a
            href={subject.url}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground"
            title="Open on platform"
          >
            <ExternalLink className="size-3.5" />
          </a>
        )}
      </span>
    );
  }
  if (subject.url) {
    return (
      <a href={subject.url} target="_blank" rel="noreferrer" className={cls} title={text}>
        {text} <ExternalLink className="size-3.5 shrink-0" />
      </a>
    );
  }
  return <span className="font-medium">{text}</span>;
}

function formatDuration(start: string | null, end: string | null): string {
  if (!start || !end) return "";
  const s = Math.round((new Date(end).getTime() - new Date(start).getTime()) / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "succeeded") return "default";
  if (s === "failed" || s === "cancelled") return "destructive";
  if (s === "running") return "outline";
  return "secondary";
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
