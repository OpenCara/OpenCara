import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { RefreshCw, RotateCcw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import {
  flowNodeSettingsQuery,
  flowRunDetailQuery,
  projectFlowsQuery,
  useRerunFlow,
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

  const settingsQ = useQuery({
    ...flowNodeSettingsQuery(projectId!, flow?.id ?? ""),
    enabled: !!flow,
  });
  const labelOverrides = useMemo<Record<string, string>>(() => {
    const m: Record<string, string> = {};
    for (const s of settingsQ.data?.settings ?? []) {
      if (s.label) m[s.nodeId] = s.label;
    }
    return m;
  }, [settingsQ.data]);

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

  const failedStep = steps.find((s) => s.status === "failed") ?? null;

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
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
        <RerunControls
          projectId={projectId!}
          runId={run.id}
          failedStep={failedStep}
        />
      </div>

      <FlowGraph
        nodes={flow.graphJson.nodes}
        edges={flow.graphJson.edges}
        stepStatuses={stepStatuses}
        labelOverrides={labelOverrides}
        onNodeClick={(id) => setSelectedNodeId(id)}
      />

      {selectedStep ? (
        <StepPanel
          step={selectedStep}
          agentRunId={selectedAgentRunId}
          projectId={projectId!}
        />
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
  projectId,
}: {
  step: FlowRunStep;
  agentRunId: string | null;
  projectId: string;
}) {
  const duration =
    step.startedAt && step.finishedAt
      ? `${Math.round(
          (new Date(step.finishedAt).getTime() - new Date(step.startedAt).getTime()) / 100,
        ) / 10}s`
      : null;
  // Engine writes a "reused" marker into inputJson when the step was carried
  // over from a prior run via Rerun-from-failed. Surface it so the user
  // knows this row didn't actually re-execute and where the original lives.
  const reused = parseReused(step.inputJson);
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">
            Step {step.idx + 1} · <span className="text-muted-foreground">{step.nodeKind}</span>
          </CardTitle>
          <div className="flex items-center gap-2">
            {reused && <Badge variant="outline">reused</Badge>}
            <Badge variant={statusVariant(step.status)}>{step.status}</Badge>
          </div>
        </div>
        {reused && (
          <p className="text-xs text-muted-foreground">
            Carried over from{" "}
            <Link
              to={`/projects/${projectId}/flow-runs/${reused.runId}`}
              className="underline hover:text-foreground"
            >
              run {reused.runId.slice(-8)}
            </Link>
            . Output below is the original captured value; click the original
            run to inspect its agent logs.
          </p>
        )}
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
        <AgentPromptPanel inputJson={step.inputJson} />
        {step.inputJson != null && (
          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              Input
            </div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-xs">
              {JSON.stringify(stripPromptFields(step.inputJson), null, 2)}
            </pre>
          </div>
        )}
        {step.outputJson != null && (
          <div>
            <div className="mb-1 text-xs uppercase tracking-wide text-muted-foreground">
              Output
            </div>
            <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 text-xs">
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
      <pre className="max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-3 font-mono text-xs leading-relaxed">
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

function RerunControls({
  projectId,
  runId,
  failedStep,
}: {
  projectId: string;
  runId: string;
  failedStep: FlowRunStep | null;
}) {
  const navigate = useNavigate();
  const rerun = useRerunFlow(projectId);

  const fire = (fromStepId?: string) => {
    rerun.mutate(
      { runId, fromStepId },
      {
        onSuccess: ({ flowRunId }) => {
          navigate(`/projects/${projectId}/flow-runs/${flowRunId}`);
        },
      },
    );
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={rerun.isPending}
          onClick={() => fire()}
          title="Re-execute every node from the original trigger event"
        >
          <RefreshCw className="size-3.5" />
          {rerun.isPending && !failedStep ? "Starting…" : "Rerun from start"}
        </Button>
        {failedStep && (
          <Button
            size="sm"
            disabled={rerun.isPending}
            onClick={() => fire(failedStep.id)}
            title={`Resume from "${failedStep.nodeId}" — reuses upstream outputs from this run`}
          >
            <RotateCcw className="size-3.5" />
            {rerun.isPending ? "Starting…" : "Rerun from failed step"}
          </Button>
        )}
      </div>
      {rerun.error && (
        <span className="text-xs text-destructive">
          {(rerun.error as Error).message ?? "Rerun failed"}
        </span>
      )}
    </div>
  );
}

function parseReused(
  inputJson: unknown,
): { runId: string; stepId: string } | null {
  if (!inputJson || typeof inputJson !== "object") return null;
  const o = inputJson as { reusedFromRunId?: unknown; reusedFromStepId?: unknown };
  if (typeof o.reusedFromRunId !== "string" || typeof o.reusedFromStepId !== "string") {
    return null;
  }
  return { runId: o.reusedFromRunId, stepId: o.reusedFromStepId };
}

interface AgentPromptInput {
  agentName?: string;
  agentKind?: string;
  systemPromptMd?: string;
  injectedSkills?: Array<{ name: string; instructions: string }>;
}

// Single source of truth for which keys on flow_run_steps.inputJson
// describe the agent's prompt (vs. node config / previousOutput /
// eventType, which stay in the raw JSON dump). Both the AgentPromptPanel
// parser and the stripPromptFields helper iterate this — adding a fifth
// prompt field is one edit, not two.
const PROMPT_FIELD_KEYS = [
  "agentName",
  "agentKind",
  "systemPromptMd",
  "injectedSkills",
] as const;

function parseAgentPrompt(inputJson: unknown): AgentPromptInput | null {
  if (!inputJson || typeof inputJson !== "object") return null;
  const o = inputJson as Record<string, unknown>;
  const out: AgentPromptInput = {};
  if (typeof o.agentName === "string") out.agentName = o.agentName;
  if (typeof o.agentKind === "string") out.agentKind = o.agentKind;
  if (typeof o.systemPromptMd === "string") out.systemPromptMd = o.systemPromptMd;
  if (Array.isArray(o.injectedSkills)) {
    out.injectedSkills = o.injectedSkills
      .map((s) => {
        if (!s || typeof s !== "object") return null;
        const rec = s as { name?: unknown; instructions?: unknown };
        if (typeof rec.name !== "string" || typeof rec.instructions !== "string") return null;
        return { name: rec.name, instructions: rec.instructions };
      })
      .filter((s): s is { name: string; instructions: string } => s !== null);
  }
  if (PROMPT_FIELD_KEYS.every((k) => out[k as keyof AgentPromptInput] === undefined)) {
    return null;
  }
  return out;
}

function stripPromptFields(inputJson: unknown): unknown {
  if (!inputJson || typeof inputJson !== "object") return inputJson;
  const o = { ...(inputJson as Record<string, unknown>) };
  for (const k of PROMPT_FIELD_KEYS) delete o[k];
  return o;
}

function AgentPromptPanel({ inputJson }: { inputJson: unknown }) {
  const prompt = parseAgentPrompt(inputJson);
  if (!prompt) return null;
  const skills = prompt.injectedSkills ?? [];
  return (
    <div className="space-y-3">
      {(prompt.agentName || prompt.agentKind) && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="uppercase tracking-wide text-muted-foreground">
            Agent
          </span>
          {prompt.agentName && (
            <span className="font-medium text-foreground">{prompt.agentName}</span>
          )}
          {prompt.agentKind && (
            <Badge variant="outline" className="font-mono">
              {prompt.agentKind}
            </Badge>
          )}
        </div>
      )}
      {skills.length > 0 && (
        <div>
          <div className="mb-1 flex flex-wrap items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
            <span>Injected skills</span>
            {skills.map((s) => (
              <Badge key={s.name} variant="secondary" className="font-mono normal-case">
                {s.name}
              </Badge>
            ))}
          </div>
          <div className="space-y-2">
            {skills.map((s) => (
              <details
                key={s.name}
                className="rounded-md border border-border/60 bg-muted/20 p-2 text-xs"
              >
                <summary className="cursor-pointer select-none font-mono text-foreground">
                  {s.name}
                </summary>
                <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 leading-relaxed">
                  {s.instructions}
                </pre>
              </details>
            ))}
          </div>
        </div>
      )}
      {prompt.systemPromptMd && (
        <details className="rounded-md border border-border/60 bg-muted/20 p-2 text-xs">
          <summary className="cursor-pointer select-none uppercase tracking-wide text-muted-foreground">
            System prompt ({prompt.systemPromptMd.length.toLocaleString()} chars)
          </summary>
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap break-words rounded bg-background/60 p-2 leading-relaxed">
            {prompt.systemPromptMd}
          </pre>
        </details>
      )}
    </div>
  );
}

function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "succeeded") return "default";
  if (s === "failed") return "destructive";
  if (s === "cancelled" || s === "skipped") return "outline";
  return "secondary";
}
