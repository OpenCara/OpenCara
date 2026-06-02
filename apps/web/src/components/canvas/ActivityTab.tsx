import { Fragment, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useSearchParams } from "react-router";
import { ChevronDown, ChevronRight } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  projectEventsQuery,
  projectFlowRunsQuery,
  projectFlowsQuery,
  projectRunsQuery,
  type FlowRunSummary,
  type FlowSummary,
} from "@/lib/queries";
import { formatRelative } from "@/lib/format";
import { summarizeEvent } from "@/lib/eventSummary";

type ActivityView = "flow-runs" | "runs" | "events";

const PILLS: { value: ActivityView; label: string }[] = [
  { value: "flow-runs", label: "Flow runs" },
  { value: "runs", label: "Agent runs" },
  { value: "events", label: "Events" },
];

function parseView(raw: string | null): ActivityView {
  if (raw === "runs" || raw === "events" || raw === "flow-runs") return raw;
  return "flow-runs";
}

/**
 * Single "what happened" surface. Merges the former Flow runs, Agent runs,
 * and Events tabs behind toggleable pill filters (not nested tabs). The
 * initial pill honors a `?view=` query param so redirected old tab URLs
 * (`/events`, `/runs`, `/flow-runs`) land on the matching filter — see #140.
 */
export function ActivityTab({ id }: { id: string }) {
  // The URL `?view=` is the source of truth, so a query-only navigation
  // (e.g. a legacy `/events` redirect landing on an already-mounted tab)
  // keeps the active pill in sync and the selection stays shareable.
  const [searchParams, setSearchParams] = useSearchParams();
  const view = parseView(searchParams.get("view"));
  const setView = (next: ActivityView) =>
    setSearchParams(
      (prev) => {
        prev.set("view", next);
        return prev;
      },
      { replace: true },
    );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        {PILLS.map((pill) => (
          <Button
            key={pill.value}
            size="sm"
            variant={view === pill.value ? "default" : "outline"}
            onClick={() => setView(pill.value)}
          >
            {pill.label}
          </Button>
        ))}
      </div>
      {view === "flow-runs" && <FlowRunsTable id={id} />}
      {view === "runs" && <RunsTable id={id} />}
      {view === "events" && <EventsTable id={id} />}
    </div>
  );
}

function EventsTable({ id }: { id: string }) {
  const q = useQuery(projectEventsQuery(id));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const toggle = (eventId: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(eventId)) next.delete(eventId);
      else next.add(eventId);
      return next;
    });
  };

  if (q.isLoading) return <Skeleton className="h-32 w-full" />;
  if (!q.data || q.data.events.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No events yet for this project.
      </div>
    );
  }
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-10" />
              <TableHead>When</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Summary</TableHead>
              <TableHead className="w-20 text-right">Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.data.events.map((e) => {
              const isOpen = expanded.has(e.id);
              return (
                <Fragment key={e.id}>
                  <TableRow
                    className="cursor-pointer"
                    onClick={() => toggle(e.id)}
                  >
                    <TableCell>
                      {isOpen ? (
                        <ChevronDown className="size-4 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-4 text-muted-foreground" />
                      )}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {formatRelative(e.receivedAt)}
                    </TableCell>
                    <TableCell>
                      <Badge variant="secondary">{e.type}</Badge>
                    </TableCell>
                    <TableCell className="text-sm">
                      {summarizeEvent(e.type, e.payload)}
                    </TableCell>
                    <TableCell className="text-right text-xs text-muted-foreground">
                      {isOpen ? "Hide" : "Show"}
                    </TableCell>
                  </TableRow>
                  {isOpen && (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={5} className="bg-muted/30 p-0">
                        <pre className="max-h-[480px] overflow-auto p-4 font-mono text-xs leading-relaxed">
                          {JSON.stringify(e.payload, null, 2)}
                        </pre>
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              );
            })}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function RunsTable({ id }: { id: string }) {
  const q = useQuery(projectRunsQuery(id));
  if (q.isLoading) return <Skeleton className="h-32 w-full" />;
  if (!q.data || q.data.runs.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No agent runs yet.
      </div>
    );
  }
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Created</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Host</TableHead>
              <TableHead>Exit code</TableHead>
              <TableHead>Duration</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {q.data.runs.map((r) => (
              <TableRow key={r.id}>
                <TableCell className="text-sm text-muted-foreground">
                  {formatRelative(r.createdAt)}
                </TableCell>
                <TableCell>
                  <Badge variant={statusVariant(r.status)}>{r.status}</Badge>
                </TableCell>
                <TableCell className="text-sm">{r.hostId ?? "—"}</TableCell>
                <TableCell className="text-sm">{r.exitCode ?? "—"}</TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {r.startedAt && r.finishedAt
                    ? `${Math.round(
                        (new Date(r.finishedAt).getTime() - new Date(r.startedAt).getTime()) / 1000,
                      )}s`
                    : "—"}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function FlowRunsTable({ id }: { id: string }) {
  const runsQ = useQuery(projectFlowRunsQuery(id));
  const flowsQ = useQuery(projectFlowsQuery(id));
  if (runsQ.isLoading || flowsQ.isLoading) {
    return <Skeleton className="h-32 w-full" />;
  }
  const runs = runsQ.data?.runs ?? [];
  const flowsById = new Map<string, FlowSummary>(
    (flowsQ.data?.flows ?? []).map((f) => [f.id, f]),
  );
  if (runs.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No flow runs yet. Open the{" "}
        <Link to={`/projects/${id}/flows`} className="underline">
          Flows tab
        </Link>{" "}
        and click <span className="font-medium">Run flow</span> to start one.
      </div>
    );
  }
  return (
    <Card>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Created</TableHead>
              <TableHead>Flow</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Duration</TableHead>
              <TableHead>Error</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {runs.map((r) => (
              <FlowRunRow key={r.id} projectId={id} run={r} flow={flowsById.get(r.flowId)} />
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function FlowRunRow({
  projectId,
  run,
  flow,
}: {
  projectId: string;
  run: FlowRunSummary;
  flow: FlowSummary | undefined;
}) {
  const duration =
    run.startedAt && run.finishedAt
      ? `${Math.round(
          (new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()) / 100,
        ) / 10}s`
      : "—";
  return (
    <TableRow>
      <TableCell className="text-sm text-muted-foreground">
        <Link
          to={`/projects/${projectId}/flow-runs/${run.id}`}
          className="hover:underline"
        >
          {formatRelative(run.createdAt)}
        </Link>
      </TableCell>
      <TableCell className="text-sm">
        {flow ? (
          <Link
            to={`/projects/${projectId}/flows/${flow.slug}`}
            className="hover:underline"
          >
            {flow.name}
          </Link>
        ) : (
          <span className="text-muted-foreground">{run.flowId}</span>
        )}
      </TableCell>
      <TableCell>
        <Badge variant={statusVariant(run.status)}>{run.status}</Badge>
      </TableCell>
      <TableCell className="text-sm">{duration}</TableCell>
      <TableCell className="max-w-md truncate text-xs text-muted-foreground">
        {run.error ?? ""}
      </TableCell>
    </TableRow>
  );
}

function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "succeeded") return "default";
  if (s === "failed" || s === "cancelled") return "destructive";
  return "secondary";
}
