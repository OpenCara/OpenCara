import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { flowDetailQuery, type FlowRunSummary } from "@/lib/queries";
import { formatRelative } from "@/lib/format";
import { FlowGraph } from "@/components/flow/FlowGraph";

export function ProjectFlowDetailPage() {
  const { id, slug } = useParams();
  const q = useQuery(flowDetailQuery(id!, slug!));

  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!q.data) return <div className="text-sm text-muted-foreground">Flow not found.</div>;

  const { flow, runs } = q.data;

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={`/projects/${id}/flows`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← All flows
        </Link>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">{flow.name}</h2>
        <p className="text-sm text-muted-foreground">
          {flow.graphJson.description ?? "—"}
        </p>
      </div>

      <FlowGraph nodes={flow.graphJson.nodes} edges={flow.graphJson.edges} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium text-muted-foreground">
            Recent runs
          </CardTitle>
        </CardHeader>
        <CardContent>
          {runs.length === 0 ? (
            <div className="py-6 text-center text-sm text-muted-foreground">
              No runs yet. Trigger one via a matching webhook event.
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((r) => (
                  <FlowRunRow key={r.id} run={r} projectId={id!} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function FlowRunRow({ run, projectId }: { run: FlowRunSummary; projectId: string }) {
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
  if (s === "failed") return "destructive";
  if (s === "cancelled") return "outline";
  return "secondary";
}
