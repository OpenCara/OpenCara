import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { flowRunDetailQuery, projectFlowsQuery, type FlowRunStep } from "@/lib/queries";
import { formatRelative, formatAbsolute } from "@/lib/format";
import { FlowGraph } from "@/components/flow/FlowGraph";
import type { StepStatus } from "@/components/flow/nodes";
import { useEventSource } from "@/lib/sse";

interface LogLine {
  seq: number;
  stream: "stdout" | "stderr";
  chunk: string;
  ts: string;
}

export function FlowRunDetailPage() {
  const { id: projectId, runId } = useParams();
  const runQ = useQuery(flowRunDetailQuery(runId!));
  const flowsQ = useQuery(projectFlowsQuery(projectId!));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const flow = useMemo(() => {
    if (!runQ.data || !flowsQ.data) return null;
    return flowsQ.data.flows.find((f) => f.id === runQ.data.run.flowId) ?? null;
  }, [runQ.data, flowsQ.data]);

  const stepStatuses = useMemo<Record<string, StepStatus>>(() => {
    if (!runQ.data) return {};
    const m: Record<string, StepStatus> = {};
    for (const s of runQ.data.steps) m[s.nodeId] = s.status;
    return m;
  }, [runQ.data]);

  if (runQ.isLoading || flowsQ.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!runQ.data || !flow) {
    return <div className="text-sm text-muted-foreground">Flow run not found.</div>;
  }

  const { run, steps, agentRuns } = runQ.data;
  const selectedStep = selectedNodeId
    ? steps.find((s) => s.nodeId === selectedNodeId) ?? null
    : null;
  const selectedAgentRunId = selectedStep
    ? agentRuns.find((a) => a.flowRunStepId === selectedStep.id)?.id ?? null
    : null;

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={`/projects/${projectId}/flows/${flow.slug}`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← {flow.name}
        </Link>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">
          Run {run.id.slice(-8)}{" "}
          <Badge variant={statusVariant(run.status)} className="ml-2 align-middle">
            {run.status}
          </Badge>
        </h2>
        <p className="text-sm text-muted-foreground">
          Created {formatAbsolute(run.createdAt)}
          {run.error && <span className="ml-2 text-destructive">— {run.error}</span>}
        </p>
      </div>

      <FlowGraph
        nodes={flow.graphJson.nodes}
        edges={flow.graphJson.edges}
        stepStatuses={stepStatuses}
        onNodeClick={(id) => setSelectedNodeId(id)}
      />

      {selectedStep ? (
        <StepPanel step={selectedStep} agentRunId={selectedAgentRunId} />
      ) : (
        <Card>
          <CardContent className="py-6 text-center text-sm text-muted-foreground">
            Click a node to inspect its step output.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function StepPanel({
  step,
  agentRunId,
}: {
  step: FlowRunStep;
  agentRunId: string | null;
}) {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            Step {step.idx + 1} · <span className="text-muted-foreground">{step.nodeKind}</span>
          </CardTitle>
          <Badge variant={statusVariant(step.status)}>{step.status}</Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {step.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {step.error}
          </div>
        )}
        {step.outputJson != null && (
          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              Output
            </div>
            <pre className="max-h-60 overflow-auto rounded-md bg-muted/30 p-3 text-xs">
              {JSON.stringify(step.outputJson, null, 2)}
            </pre>
          </div>
        )}
        {agentRunId && (
          <>
            <Separator />
            <AgentLogPanel agentRunId={agentRunId} />
          </>
        )}
      </CardContent>
    </Card>
  );
}

function AgentLogPanel({ agentRunId }: { agentRunId: string }) {
  const { events, ended, error } = useEventSource<LogLine>(
    `/api/runs/${agentRunId}/logs/stream`,
    {
      parse: (e) => (e.event === "log" ? (JSON.parse(e.data) as LogLine) : null),
    },
  );

  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-xs uppercase tracking-wide text-muted-foreground">
        <span>Agent logs</span>
        <span>{ended ? "ended" : error ? `error: ${error}` : "live"}</span>
      </div>
      <pre className="max-h-72 overflow-auto rounded-md bg-muted/30 p-3 font-mono text-xs leading-relaxed">
        {events.length === 0
          ? "(no output)"
          : events.map((e) => (
              <span
                key={e.seq}
                className={e.stream === "stderr" ? "text-destructive" : undefined}
              >
                {e.chunk}
              </span>
            ))}
      </pre>
    </div>
  );
}

function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "succeeded") return "default";
  if (s === "failed") return "destructive";
  if (s === "cancelled" || s === "skipped") return "outline";
  return "secondary";
}
