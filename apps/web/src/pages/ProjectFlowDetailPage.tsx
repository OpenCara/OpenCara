import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import {
  Bot,
  Cpu,
  ExternalLink,
  Pause,
  Play,
  Plus,
  PowerOff,
  Sparkles,
  Trash2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
  useAddReviewer,
  useRemoveReviewer,
  useSetFlowEnabled,
  useSetFlowNodeSettings,
  useTriggerFlow,
  type FlowNodeSetting,
  type FlowRunSummary,
} from "@/lib/queries";
import { formatRelative } from "@/lib/format";
import { FlowGraph } from "@/components/flow/FlowGraph";

const NONE = "__none__";

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
  const reviewerNodeIds = isMultiReview ? deriveReviewerIds(flow.graphJson) : new Set<string>();
  const reviewerCount = reviewerNodeIds.size;
  const selectedIsReviewer = selectedNode ? reviewerNodeIds.has(selectedNode.id) : false;

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

      {isMultiReview && (
        <ReviewerControls
          projectId={projectId}
          flow={flow}
          reviewerCount={reviewerCount}
          selectedReviewerId={selectedIsReviewer ? selectedNode!.id : null}
          onRemoved={() => setSelectedNodeId(null)}
        />
      )}

      {selectedNode && selectedNode.kind === "agent" && (
        <AgentNodePanel
          projectId={projectId}
          flowId={flow.id}
          node={selectedNode}
          settings={settings}
          prompts={prompts}
          agents={agents}
          onClose={() => setSelectedNodeId(null)}
        />
      )}
      {selectedNode && selectedNode.kind !== "agent" && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">{selectedNode.kind}</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            This node has no configurable settings yet.
          </CardContent>
        </Card>
      )}

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

interface AgentSummary {
  id: string;
  name: string;
  command: string;
  args: string[];
  runOn: string;
}

interface AgentNodePanelProps {
  projectId: string;
  flowId: string;
  node: { id: string; config?: Record<string, unknown> };
  settings: FlowNodeSetting[];
  prompts: { id: string; name: string; body: string }[];
  agents: AgentSummary[];
  onClose: () => void;
}

function AgentNodePanel({
  projectId,
  flowId,
  node,
  settings,
  prompts,
  agents,
  onClose,
}: AgentNodePanelProps) {
  const setting = settings.find((s) => s.nodeId === node.id);
  const linkedPromptId = setting?.promptId ?? null;
  const linkedAgentId = setting?.agentId ?? null;
  const linkedPrompt = linkedPromptId
    ? prompts.find((p) => p.id === linkedPromptId) ?? null
    : null;
  const linkedAgent = linkedAgentId
    ? agents.find((a) => a.id === linkedAgentId) ?? null
    : null;
  const set = useSetFlowNodeSettings(projectId, flowId);

  const cfg = (node.config ?? {}) as { label?: string };
  const defaultLabel = cfg.label ?? "Agent";
  const customLabel = setting?.label ?? null;

  // Local input state, seeded by the persisted custom label (or empty so the
  // default label shows through as placeholder).
  const [labelDraft, setLabelDraft] = useState(customLabel ?? "");
  // Re-seed when switching to a different node — otherwise the input would
  // keep the previous node's draft.
  useEffect(() => {
    setLabelDraft(customLabel ?? "");
  }, [node.id, customLabel]);

  const commitLabel = () => {
    const trimmed = labelDraft.trim();
    const next = trimmed === "" ? null : trimmed;
    if (next === customLabel) return;
    set.mutate({ nodeId: node.id, label: next });
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">
              {customLabel ?? defaultLabel}
              <span className="ml-2 text-xs font-normal text-muted-foreground">
                #{node.id}
              </span>
            </CardTitle>
          </div>
          <Button size="sm" variant="ghost" onClick={onClose}>
            Close
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="space-y-2">
          <div className="text-sm font-medium">Display name</div>
          <Input
            value={labelDraft}
            placeholder={defaultLabel}
            onChange={(e) => setLabelDraft(e.target.value)}
            onBlur={commitLabel}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                (e.target as HTMLInputElement).blur();
              }
            }}
            className="max-w-md"
          />
          <p className="text-xs text-muted-foreground">
            Shown on the graph + used as a section heading when feeding a synthesizer.
            Empty resets to "{defaultLabel}".
          </p>
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-1 text-sm font-medium">
            <Cpu className="size-3.5" />
            Linked agent
            <span className="text-xs font-normal text-muted-foreground">(required)</span>
          </div>
          <Select
            value={linkedAgentId ?? NONE}
            onValueChange={(v) => {
              set.mutate({ nodeId: node.id, agentId: v === NONE ? null : v });
            }}
          >
            <SelectTrigger className="w-full max-w-md">
              <SelectValue placeholder="(none — runs will fail)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>(none — runs will fail)</SelectItem>
              {agents.map((a) => (
                <SelectItem key={a.id} value={a.id}>
                  {a.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {agents.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No agents yet.{" "}
              <Link to="/agents" className="text-foreground underline">
                Create one
              </Link>{" "}
              before this flow can run.
            </p>
          )}
          {linkedAgent && (
            <pre className="mt-2 rounded-md border bg-muted/30 p-3 font-mono text-xs">
              $ {linkedAgent.command}
              {linkedAgent.args.length ? " " : ""}
              {linkedAgent.args.join(" ")}
              <span className="ml-2 text-muted-foreground">[runs on: {linkedAgent.runOn}]</span>
            </pre>
          )}
        </div>

        <div className="space-y-2">
          <div className="flex items-center gap-1 text-sm font-medium">
            <Sparkles className="size-3.5" />
            Linked prompt
            <span className="text-xs font-normal text-muted-foreground">(optional)</span>
          </div>
          <Select
            value={linkedPromptId ?? NONE}
            onValueChange={(v) => {
              set.mutate({ nodeId: node.id, promptId: v === NONE ? null : v });
            }}
          >
            <SelectTrigger className="w-full max-w-md">
              <SelectValue placeholder="(none)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>(none)</SelectItem>
              {prompts.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {prompts.length === 0 && (
            <p className="text-xs text-muted-foreground">
              No prompts yet.{" "}
              <Link to="/prompts" className="text-foreground underline">
                Create one
              </Link>
              .
            </p>
          )}
          {linkedPrompt && (
            <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border bg-muted/30 p-3 font-mono text-xs">
              {linkedPrompt.body}
            </pre>
          )}
          {set.error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              Save failed.
            </div>
          )}
          <Link
            to="/prompts"
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Manage prompts <ExternalLink className="size-3" />
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}

interface ReviewerControlsProps {
  projectId: string;
  flow: { id: string; slug: string };
  reviewerCount: number;
  selectedReviewerId: string | null;
  onRemoved: () => void;
}

function ReviewerControls({
  projectId,
  flow,
  reviewerCount,
  selectedReviewerId,
  onRemoved,
}: ReviewerControlsProps) {
  const add = useAddReviewer(projectId, flow.slug);
  const remove = useRemoveReviewer(projectId, flow.slug);
  const error = add.error ?? remove.error;
  return (
    <div className="flex items-center gap-3">
      <Button
        size="sm"
        variant="outline"
        onClick={() => add.mutate(flow.id)}
        disabled={add.isPending}
      >
        <Plus className="size-3.5" />
        {add.isPending ? "Adding…" : "Add reviewer"}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          if (!selectedReviewerId) return;
          remove.mutate(
            { flowId: flow.id, nodeId: selectedReviewerId },
            { onSuccess: onRemoved },
          );
        }}
        disabled={
          remove.isPending || !selectedReviewerId || reviewerCount <= 1
        }
        title={
          !selectedReviewerId
            ? "Click a reviewer node first"
            : reviewerCount <= 1
              ? "Cannot remove the last reviewer"
              : "Remove the selected reviewer"
        }
      >
        <Trash2 className="size-3.5" />
        {remove.isPending ? "Removing…" : "Remove selected reviewer"}
      </Button>
      <span className="text-xs text-muted-foreground">
        {reviewerCount} reviewer{reviewerCount === 1 ? "" : "s"}
      </span>
      {error && (
        <span className="text-xs text-destructive">{(error as Error).message}</span>
      )}
    </div>
  );
}

/**
 * A "reviewer" node, in the multi-agent review flow, is any agent node that
 * sits between the trigger and the synthesizer (i.e. has trigger as an upstream
 * AND synthesizer as a downstream). This is purely structural so it survives
 * graph customisation (added reviewers retain the role).
 */
function deriveReviewerIds(graph: {
  nodes: Array<{ id: string; kind: string }>;
  edges: Array<{ source: string; target: string }>;
}): Set<string> {
  const trigger = graph.nodes.find((n) => n.kind === "github.pull_request");
  const synth = graph.nodes.find(
    (n) => n.kind === "agent" && (n.id === "synthesizer" || /synth/i.test(n.id)),
  );
  if (!trigger || !synth) return new Set();
  const ids = new Set<string>();
  for (const n of graph.nodes) {
    if (n.kind !== "agent") continue;
    if (n.id === synth.id) continue;
    const fromTrigger = graph.edges.some((e) => e.source === trigger.id && e.target === n.id);
    const toSynth = graph.edges.some((e) => e.source === n.id && e.target === synth.id);
    if (fromTrigger && toSynth) ids.add(n.id);
  }
  return ids;
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
