import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleSlash,
  Clock,
  ExternalLink,
  Loader2,
  StopCircle,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  flowRunDetailQuery,
  issueFlowRunsQuery,
  useCancelFlowRun,
  type AgentRunRow,
  type FlowRunStep,
  type FlowRunSummary,
  type IssueFlowRun,
} from "@/lib/queries";
import { formatAbsolute, formatRelative } from "@/lib/format";
import { useEventSource } from "@/lib/sse";

interface FlowRunSnapshot {
  run: FlowRunSummary;
  steps: FlowRunStep[];
  agentRuns: AgentRunRow[];
}

interface LogLine {
  seq: number;
  stream: "stdout" | "stderr";
  chunk: string;
  ts: string;
}

const ACTIVE_STATES = new Set<IssueFlowRun["status"]>(["pending", "running"]);

/**
 * Live agent progress and steering controls for an issue editing page.
 *
 * The panel polls `GET /projects/:id/issues/:n/flow-runs` to discover any
 * flow runs that targeted this issue. If the most recent run is still
 * pending/running, it subscribes to the flow run's SSE stream to show
 * live step status + agent log lines, and exposes a Cancel button.
 *
 * Past (terminal) runs are listed below the live section in
 * reverse-chronological order with a small expander that surfaces the
 * error message (if any), the duration, and a deep-link to the flow-run
 * detail page where the user can inspect agent prompts and per-step
 * outputs.
 *
 * Why the active-vs-history split: a fresh implement run gets the live
 * panel, while older runs collapse into a compact list so the page
 * doesn't grow unbounded as users iterate. Subscribing to the SSE stream
 * for only the active run also keeps the EventSource count at exactly
 * one per page.
 */
export function IssueAgentProgress({
  projectId,
  issueNumber,
}: {
  projectId: string;
  issueNumber: number;
}) {
  const runsQ = useQuery({
    ...issueFlowRunsQuery(projectId, issueNumber),
    // Active runs publish status updates through pg NOTIFY → SSE on the
    // detail stream, which we subscribe to below. For terminal-state
    // refreshes (new history rows arriving after a re-trigger), a short
    // poll keeps the list current without webhook plumbing into this
    // route. 10s is a balance between snappiness and request volume.
    refetchInterval: 10_000,
  });

  const runs = runsQ.data?.runs ?? [];
  const activeRun = runs.find((r) => ACTIVE_STATES.has(r.status)) ?? null;
  // Filter by id rather than reference so a future refactor that re-shapes
  // the run objects (e.g. memoised projections) doesn't quietly start
  // including the active run twice.
  const historyRuns = runs.filter((r) => r.id !== activeRun?.id);

  return (
    <div className="border-b">
      <div className="px-6 py-4">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Agent activity
          </h2>
          {runs.length > 0 && (
            <span className="text-xs text-muted-foreground">
              {runs.length} run{runs.length === 1 ? "" : "s"}
            </span>
          )}
        </div>

        {runsQ.isLoading ? (
          <div className="text-xs text-muted-foreground">Loading…</div>
        ) : runs.length === 0 ? (
          <EmptyState />
        ) : (
          <div className="space-y-4">
            {activeRun ? (
              <ActiveRunPanel
                projectId={projectId}
                issueNumber={issueNumber}
                run={activeRun}
              />
            ) : (
              <NoActiveRunHint mostRecent={historyRuns[0] ?? null} />
            )}

            {historyRuns.length > 0 && (
              <HistorySection projectId={projectId} runs={historyRuns} />
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="rounded-md border border-dashed bg-muted/20 p-4 text-xs text-muted-foreground">
      No implement runs yet for this issue. Pick an agent and click{" "}
      <span className="font-mono">Start</span> from the kanban card, or
      label the issue with <span className="font-mono">agent:&lt;name&gt;</span>{" "}
      to let webhook-driven triggers fire.
    </div>
  );
}

function NoActiveRunHint({ mostRecent }: { mostRecent: IssueFlowRun | null }) {
  if (!mostRecent) return null;
  const tone = STATUS_PRESENTATION[mostRecent.status];
  const Icon = tone.icon;
  return (
    <div className="flex items-center gap-2 rounded-md border bg-muted/10 px-3 py-2 text-xs text-muted-foreground">
      <Icon className={`size-3.5 shrink-0 ${tone.color}`} />
      <span>
        No run currently active. Most recent: {tone.label.toLowerCase()}{" "}
        {formatRelative(mostRecent.createdAt)}.
      </span>
    </div>
  );
}

function ActiveRunPanel({
  projectId,
  issueNumber,
  run,
}: {
  projectId: string;
  issueNumber: number;
  run: IssueFlowRun;
}) {
  const live = useFlowRunSnapshot(run.id);
  const fallbackQ = useQuery({
    ...flowRunDetailQuery(run.id),
    // SSE is the primary source; this is just a one-shot seed for the
    // step list while the stream connects. Keep it cheap.
    enabled: !live,
    staleTime: 30_000,
  });
  const snapshot: FlowRunSnapshot | null =
    live ?? (fallbackQ.data as FlowRunSnapshot | undefined) ?? null;

  const status = snapshot?.run.status ?? run.status;
  const currentStep =
    snapshot?.steps.find((s) => s.status === "running") ?? null;
  const currentNodeKind = currentStep?.nodeKind ?? run.currentNodeKind;
  const startedAt = snapshot?.run.startedAt ?? run.startedAt;
  const elapsed = useElapsedSeconds(startedAt, status);

  const cancel = useCancelFlowRun(projectId, issueNumber);
  const canCancel = status === "pending" || status === "running";

  // The newest still-running agent_run drives the log tail. When the step
  // succeeds and a follow-up step kicks off, we pivot to the new agent run.
  const activeAgentRunId = useMemo(() => {
    if (!snapshot) return null;
    const runningStep = snapshot.steps.find((s) => s.status === "running");
    if (runningStep) {
      const ar = snapshot.agentRuns.find(
        (a) => a.flowRunStepId === runningStep.id,
      );
      if (ar) return ar.id;
    }
    // Fallback: the most recent agent_run (covers "between steps" where no
    // step is currently flagged running but the agent is still warming up).
    const sorted = [...snapshot.agentRuns].sort((a, b) =>
      a.createdAt > b.createdAt ? -1 : 1,
    );
    return sorted[0]?.id ?? null;
  }, [snapshot]);

  return (
    <div className="rounded-md border bg-card p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <RunningIcon status={status} />
            <span className="text-sm font-medium">
              {labelForRun(status, currentNodeKind)}
            </span>
            <Badge variant="outline" className="font-mono text-[10px]">
              {run.flowSlug}
            </Badge>
          </div>
          <div className="mt-1 flex flex-wrap gap-3 text-xs text-muted-foreground">
            <span>Started {startedAt ? formatRelative(startedAt) : "—"}</span>
            <span>·</span>
            <span>Elapsed {formatDuration(elapsed)}</span>
            <span>·</span>
            <Link
              to={`/projects/${projectId}/flow-runs/${run.id}`}
              className="flex items-center gap-1 hover:text-foreground"
            >
              Run {run.id.slice(-8)} <ExternalLink className="size-3" />
            </Link>
          </div>
        </div>
        <div className="flex flex-col items-end gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!canCancel || cancel.isPending}
            onClick={() => cancel.mutate(run.id)}
            title="Stop the running implement flow"
          >
            <StopCircle className="mr-1 size-3.5" />
            {cancel.isPending ? "Cancelling…" : "Cancel"}
          </Button>
          {cancel.error && (
            <span
              className="text-[10px] text-destructive"
              title={
                cancel.error instanceof Error
                  ? cancel.error.message
                  : String(cancel.error)
              }
            >
              cancel failed
            </span>
          )}
        </div>
      </div>

      {snapshot && snapshot.steps.length > 0 && (
        <StepStrip steps={snapshot.steps} />
      )}

      <SteeringNotice />

      {activeAgentRunId && (
        <AgentLogTail agentRunId={activeAgentRunId} />
      )}
    </div>
  );
}

/**
 * Mirror of FlowRunDetailPage's useFlowRunStream — subscribe to the
 * flow_run SSE stream and surface the latest snapshot. Returns null while
 * the initial connect is in flight; the caller falls back to a one-shot
 * react-query fetch in that gap so the user sees something immediately.
 */
function useFlowRunSnapshot(runId: string): FlowRunSnapshot | null {
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

/**
 * Tick a counter while the run is in-flight so the elapsed-time label
 * actually updates without re-fetching the snapshot. Frozen once the run
 * leaves the running state — at that point startedAt + finishedAt give
 * the final duration directly.
 */
function useElapsedSeconds(
  startedAt: string | null,
  status: string,
): number | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (status !== "running" && status !== "pending") return;
    const id = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(id);
  }, [status]);
  if (!startedAt) return null;
  return (Date.now() - new Date(startedAt).getTime()) / 1000;
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  if (seconds < 60) return `${Math.floor(seconds)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  if (m < 60) return `${m}m ${s}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function RunningIcon({ status }: { status: string }) {
  switch (status) {
    case "running":
      return <Loader2 className="size-4 animate-spin text-blue-600" />;
    case "pending":
      return <Clock className="size-4 text-muted-foreground" />;
    case "succeeded":
      return <CheckCircle2 className="size-4 text-green-600" />;
    case "failed":
      return <AlertCircle className="size-4 text-destructive" />;
    case "cancelled":
      return <CircleSlash className="size-4 text-muted-foreground" />;
    default:
      return <Clock className="size-4 text-muted-foreground" />;
  }
}

function labelForRun(
  status: string,
  runningNodeKind: string | null,
): string {
  if (status === "pending") return "Queued";
  if (status === "failed") return "Failed";
  if (status === "cancelled") return "Cancelled";
  if (status === "succeeded") return "Completed";
  switch (runningNodeKind) {
    case "agent":
      return "Implementing…";
    case "git.create_pr":
      return "Creating PR…";
    case "git.create_worktree":
      return "Preparing worktree…";
    case "github.post_review":
      return "Posting review…";
    case "github.add_comment":
      return "Commenting…";
    case "github.add_label":
      return "Labelling…";
    default:
      return runningNodeKind ? `Working (${runningNodeKind})…` : "Starting…";
  }
}

/** Mini step indicator strip — one chip per step so the user can see how
 * far through the flow the agent is without opening the detail page. */
function StepStrip({ steps }: { steps: FlowRunStep[] }) {
  if (steps.length === 0) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-1">
      {steps.map((s) => {
        const tone = STEP_TONE[s.status] ?? STEP_TONE.pending;
        return (
          <span
            key={s.id}
            className={`rounded px-1.5 py-0.5 font-mono text-[10px] ${tone}`}
            title={`${s.nodeId} (${s.status})`}
          >
            {s.nodeId}
          </span>
        );
      })}
    </div>
  );
}

const STEP_TONE: Record<string, string> = {
  pending: "bg-muted/40 text-muted-foreground",
  running: "bg-blue-500/15 text-blue-700 dark:text-blue-300",
  succeeded: "bg-green-500/10 text-green-700 dark:text-green-300",
  failed: "bg-destructive/15 text-destructive",
  skipped: "bg-muted/40 text-muted-foreground line-through",
};

/**
 * Steering controls are not yet wired into the running agent's ACP
 * session. We surface the affordance as a visible, disabled section so
 * users see where it'll live; full plumbing (live message inject,
 * pause/resume) is tracked separately because it touches the dispatcher
 * and ACP adapters, not just the issue page.
 */
function SteeringNotice() {
  return (
    <div className="mt-3 rounded-md border border-dashed bg-muted/10 p-2 text-[11px] text-muted-foreground">
      Steering (send instruction · pause / resume) is not yet supported for
      flow-driven runs. Cancel and re-trigger with a new agent label or an
      updated issue body to redirect the work.
    </div>
  );
}

/** Bottom-of-panel live log tail, capped at the last 60 chunks so a chatty
 * agent doesn't blow up the page. Mirrors the AgentLogPanel from
 * FlowRunDetailPage but trimmed for an at-a-glance view. */
function AgentLogTail({ agentRunId }: { agentRunId: string }) {
  // Cap the underlying buffer at 60 chunks too — `events.slice(-60)` only
  // trims at render, but the accumulator inside useEventSource keeps every
  // chunk a chatty agent emits and that's what pins memory on long runs.
  const { events, ended, error } = useEventSource<LogLine>(
    `/api/runs/${agentRunId}/logs/stream`,
    {
      parse: (e) => (e.event === "log" ? (JSON.parse(e.data) as LogLine) : null),
      dedupeKey: (row) => row.seq,
      maxBuffer: 60,
    },
  );

  const tail = events;

  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between text-[10px] uppercase tracking-wide text-muted-foreground">
        <span>Live output</span>
        <span>{ended ? "ended" : error ? `error: ${error}` : "live"}</span>
      </div>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/30 p-2 font-mono text-[11px] leading-snug">
        {tail.length === 0
          ? "(no output yet)"
          : tail.map((e) => (
              <span
                key={e.seq}
                className={
                  e.stream === "stderr" ? "text-destructive" : undefined
                }
              >
                {e.chunk}
              </span>
            ))}
      </pre>
    </div>
  );
}

function HistorySection({
  projectId,
  runs,
}: {
  projectId: string;
  runs: IssueFlowRun[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        Past runs ({runs.length})
      </button>
      {open && (
        <ul className="mt-2 divide-y rounded-md border bg-card">
          {runs.map((r) => (
            <HistoryRow key={r.id} projectId={projectId} run={r} />
          ))}
        </ul>
      )}
    </div>
  );
}

function HistoryRow({
  projectId,
  run,
}: {
  projectId: string;
  run: IssueFlowRun;
}) {
  const [open, setOpen] = useState(false);
  const tone = STATUS_PRESENTATION[run.status];
  const Icon = tone.icon;
  const duration =
    run.startedAt && run.finishedAt
      ? formatDuration(
          (new Date(run.finishedAt).getTime() -
            new Date(run.startedAt).getTime()) /
            1000,
        )
      : null;
  return (
    <li className="px-3 py-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex min-w-0 flex-1 items-center gap-2 text-left hover:text-foreground"
        >
          {open ? (
            <ChevronDown className="size-3 shrink-0" />
          ) : (
            <ChevronRight className="size-3 shrink-0" />
          )}
          <Icon className={`size-3 shrink-0 ${tone.color}`} />
          <span className="truncate">
            {tone.label} · {run.flowSlug}
          </span>
          <span className="ml-2 shrink-0 text-muted-foreground">
            {formatRelative(run.createdAt)}
          </span>
        </button>
        <Link
          to={`/projects/${projectId}/flow-runs/${run.id}`}
          className="shrink-0 text-muted-foreground hover:text-foreground"
          title="Open flow run detail"
        >
          <ExternalLink className="size-3" />
        </Link>
      </div>
      {open && (
        <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 pl-5 text-[11px] text-muted-foreground">
          <span>Created {formatAbsolute(run.createdAt)}</span>
          <span>Duration {duration ?? "—"}</span>
          <span className="col-span-2 font-mono">Run {run.id}</span>
          {run.error && (
            <div className="col-span-2 mt-1 rounded border border-destructive/30 bg-destructive/10 p-2 text-destructive">
              {run.error}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

const STATUS_PRESENTATION: Record<
  IssueFlowRun["status"],
  { icon: typeof Loader2; color: string; label: string }
> = {
  pending: { icon: Clock, color: "text-muted-foreground", label: "Queued" },
  running: { icon: Loader2, color: "text-blue-600", label: "Running" },
  succeeded: {
    icon: CheckCircle2,
    color: "text-green-600",
    label: "Succeeded",
  },
  failed: { icon: AlertCircle, color: "text-destructive", label: "Failed" },
  cancelled: {
    icon: CircleSlash,
    color: "text-muted-foreground",
    label: "Cancelled",
  },
};
