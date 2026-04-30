import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { Pause, Play, PowerOff } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  agentsQuery,
  flowDetailQuery,
  flowNodeSettingsQuery,
  promptsQuery,
  useSetFlowEnabled,
  useTriggerFlow,
  type FlowRunSummary,
} from "@/lib/queries";
import { formatRelative } from "@/lib/format";
import { FlowGraph } from "@/components/flow/FlowGraph";
import { NodeEditor, type EditorScope } from "@/components/flow/NodeEditor";

export function ProjectFlowDetailPage() {
  const { id, slug } = useParams();
  const projectId = id!;
  const navigate = useNavigate();
  const q = useQuery(flowDetailQuery(projectId, slug!));
  const promptsQ = useQuery(promptsQuery());
  const agentsQ = useQuery(agentsQuery());
  const settingsQ = useQuery({
    ...flowNodeSettingsQuery(projectId, q.data?.flow.id ?? ""),
    enabled: !!q.data,
  });
  const trigger = useTriggerFlow(projectId);
  const setEnabled = useSetFlowEnabled(projectId, slug!);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!q.data) return <div className="text-sm text-muted-foreground">Flow not found.</div>;

  const { flow, runs } = q.data;
  const settings = settingsQ.data?.settings ?? [];
  const prompts = promptsQ.data?.prompts ?? [];
  const agents = agentsQ.data?.agents ?? [];
  const selectedNode = selectedNodeId
    ? flow.graphJson.nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;

  const labelOverrides = Object.fromEntries(
    settings.filter((s) => s.label).map((s) => [s.nodeId, s.label as string]),
  );

  const isMultiReview = flow.slug === "pr-review-multi";

  const scope: EditorScope = {
    kind: "project",
    projectId,
    slug: flow.slug,
    flowId: flow.id,
  };

  const onRun = () => {
    trigger.mutate(flow.slug, {
      onSuccess: ({ flowRunId }) => {
        navigate(`/projects/${projectId}/flow-runs/${flowRunId}`);
      },
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            to={`/projects/${projectId}/flows`}
            className="text-sm text-muted-foreground hover:text-foreground"
          >
            ← All flows
          </Link>
          <h2 className="mt-1 text-xl font-semibold tracking-tight">
            {flow.name}
            {!flow.enabled && (
              <Badge variant="outline" className="ml-2 align-middle">
                disabled
              </Badge>
            )}
          </h2>
          <p className="text-sm text-muted-foreground">
            {flow.graphJson.description ?? "—"}
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() => setEnabled.mutate(!flow.enabled)}
              disabled={setEnabled.isPending}
              title={
                flow.enabled
                  ? "Disable: webhook events are ignored and Run flow is blocked"
                  : "Enable: flow responds to webhook events again"
              }
            >
              {flow.enabled ? (
                <>
                  <Pause className="size-3.5" />
                  Disable
                </>
              ) : (
                <>
                  <PowerOff className="size-3.5" />
                  Enable
                </>
              )}
            </Button>
            <Button
              size="sm"
              onClick={onRun}
              disabled={trigger.isPending || !flow.enabled}
              title={!flow.enabled ? "Enable the flow first" : undefined}
            >
              <Play className="size-3.5" />
              {trigger.isPending ? "Starting…" : "Run flow"}
            </Button>
          </div>
          {(trigger.error || setEnabled.error) && (
            <span className="text-xs text-destructive">
              {((trigger.error ?? setEnabled.error) as Error).message ?? "Action failed"}
            </span>
          )}
        </div>
      </div>

      <FlowGraph
        nodes={flow.graphJson.nodes}
        edges={flow.graphJson.edges}
        labelOverrides={labelOverrides}
        onNodeClick={(nid) => setSelectedNodeId(nid)}
      />

      <NodeEditor
        scope={scope}
        graph={flow.graphJson}
        selectedNode={selectedNode}
        settings={settings}
        agents={agents}
        prompts={prompts}
        showReviewerControls={isMultiReview}
        onSelectedNodeRemoved={() => setSelectedNodeId(null)}
        onClose={() => setSelectedNodeId(null)}
      />

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
                  <FlowRunRow key={r.id} run={r} projectId={projectId} />
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
