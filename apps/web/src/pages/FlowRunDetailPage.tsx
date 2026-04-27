import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import {
  flowRunDetailQuery,
  projectFlowsQuery,
  type AgentRunRow,
  type FlowRunStep,
  type FlowRunSummary,
} from "@/lib/queries";
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

interface FlowRunSnapshot {
  run: FlowRunSummary;
  steps: FlowRunStep[];
  agentRuns: AgentRunRow[];
}

export function FlowRunDetailPage() {
  const { id: projectId, runId } = useParams();
  const initialQ = useQuery(flowRunDetailQuery(runId!));
  const flowsQ = useQuery(projectFlowsQuery(projectId!));
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  const live = useFlowRunStream(runId!);
  const data = live ?? initialQ.data ?? null;

  const flow = useMemo(() => {
    if (!data || !flowsQ.data) return null;
    return flowsQ.data.flows.find((f) => f.id === data.run.flowId) ?? null;
  }, [data, flowsQ.data]);

  const stepStatuses = useMemo<Record<string, StepStatus>>(() => {
    if (!data) return {};
    const m: Record<string, StepStatus> = {};
    for (const s of data.steps) m[s.nodeId] = s.status;
    return m;
  }, [data]);

  if ((initialQ.isLoading && !data) || flowsQ.isLoading) {
    return <Skeleton className="h-64 w-full" />;
  }
  if (!data || !flow) {
    return <div className="text-sm text-muted-foreground">Flow run not found.</div>;
  }

  const { run, steps, agentRuns } = data;
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

/**
 * Subscribe to the flow-run SSE and return the latest snapshot. Falls back to
 * null while the initial connect is in flight (caller mixes in the cached
 * react-query data).
 */
function useFlowRunStream(runId: string): FlowRunSnapshot | null {
  const [snapshot, setSnapshot] = useState<FlowRunSnapshot | null>(null);
  const latestRef = useRef<FlowRunSnapshot | null>(null);

  const { events } = useEventSource<FlowRunSnapshot>(
    `/api/flow-runs/${runId}/events/stream`,
    {
      events: ["snapshot", "step"],
      parse: (e) => {
        if (e.event !== "snapshot" && e.event !== "step") return null;
        return JSON.parse(e.data) as FlowRunSnapshot;
      },
    },
  );

  useEffect(() => {
    const next = events[events.length - 1];
    if (!next || next === latestRef.current) return;
    latestRef.current = next;
    setSnapshot(next);
  }, [events]);

  return snapshot;
}

function StepPanel({
  step,
  agentRunId,
}: {
  step: FlowRunStep;
  agentRunId: string | null;
}) {
  const duration =
    step.startedAt && step.finishedAt
      ? `${Math.round(
          (new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime()) / 100,
        ) / 10}s`
      : null;
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
        <div className="grid grid-cols-3 gap-3 text-xs text-muted-foreground">
          <div>
            <div className="uppercase tracking-wide">Started</div>
            <div className="text-foreground">
              {step.startedAt ? formatRelative(step.startedAt) : "—"}
            </div>
          </div>
          <div>
            <div className="uppercase tracking-wide">Finished</div>
            <div className="text-foreground">
              {step.finishedAt ? formatRelative(step.finishedAt) : "—"}
            </div>
          </div>
          <div>
            <div className="uppercase tracking-wide">Duration</div>
            <div className="text-foreground">{duration ?? "—"}</div>
          </div>
        </div>
        {step.error && (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {step.error}
          </div>
        )}
        {step.inputJson != null && (
          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              Input
            </div>
            <pre className="max-h-60 overflow-auto rounded-md bg-muted/30 p-3 text-xs">
              {JSON.stringify(step.inputJson, null, 2)}
            </pre>
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
