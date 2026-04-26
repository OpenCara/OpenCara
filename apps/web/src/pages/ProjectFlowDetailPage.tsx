import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { Bot, ExternalLink, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
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
  flowDetailQuery,
  flowNodeSettingsQuery,
  promptsQuery,
  useSetFlowNodePrompt,
  type FlowRunSummary,
} from "@/lib/queries";
import { formatRelative } from "@/lib/format";
import { FlowGraph } from "@/components/flow/FlowGraph";

const NONE = "__none__";

export function ProjectFlowDetailPage() {
  const { id, slug } = useParams();
  const projectId = id!;
  const q = useQuery(flowDetailQuery(projectId, slug!));
  const promptsQ = useQuery(promptsQuery(projectId));
  const settingsQ = useQuery({
    ...flowNodeSettingsQuery(projectId, q.data?.flow.id ?? ""),
    enabled: !!q.data,
  });
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!q.data) return <div className="text-sm text-muted-foreground">Flow not found.</div>;

  const { flow, runs } = q.data;
  const settings = settingsQ.data?.settings ?? [];
  const prompts = promptsQ.data?.prompts ?? [];
  const selectedNode = selectedNodeId
    ? flow.graphJson.nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;

  return (
    <div className="space-y-6">
      <div>
        <Link
          to={`/projects/${projectId}/flows`}
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← All flows
        </Link>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">{flow.name}</h2>
        <p className="text-sm text-muted-foreground">
          {flow.graphJson.description ?? "—"}
        </p>
      </div>

      <FlowGraph
        nodes={flow.graphJson.nodes}
        edges={flow.graphJson.edges}
        onNodeClick={(nid) => setSelectedNodeId(nid)}
      />

      {selectedNode && selectedNode.kind === "agent" && (
        <AgentNodePanel
          projectId={projectId}
          flowId={flow.id}
          node={selectedNode}
          settings={settings}
          prompts={prompts}
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

interface AgentNodePanelProps {
  projectId: string;
  flowId: string;
  node: { id: string; config?: Record<string, unknown> };
  settings: { nodeId: string; promptId: string | null }[];
  prompts: { id: string; name: string; body: string }[];
  onClose: () => void;
}

function AgentNodePanel({
  projectId,
  flowId,
  node,
  settings,
  prompts,
  onClose,
}: AgentNodePanelProps) {
  const setting = settings.find((s) => s.nodeId === node.id);
  const linkedPromptId = setting?.promptId ?? null;
  const linkedPrompt = linkedPromptId
    ? prompts.find((p) => p.id === linkedPromptId) ?? null
    : null;
  const set = useSetFlowNodePrompt(projectId, flowId);

  const cfg = (node.config ?? {}) as { label?: string; spec?: { command?: string } };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-muted-foreground" />
            <CardTitle className="text-base">
              {cfg.label ?? "Agent"}
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
      <CardContent className="space-y-4">
        {cfg.spec?.command && (
          <div className="text-xs text-muted-foreground">
            Runs: <code className="font-mono">{cfg.spec.command}</code>
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center gap-1 text-sm font-medium">
            <Sparkles className="size-3.5" />
            Linked prompt
          </div>
          <Select
            value={linkedPromptId ?? NONE}
            onValueChange={(v) => {
              set.mutate({
                nodeId: node.id,
                promptId: v === NONE ? null : v,
              });
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
              No prompts in this project yet.{" "}
              <Link
                to={`/projects/${projectId}/prompts`}
                className="text-foreground underline"
              >
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
            to={`/projects/${projectId}/prompts`}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          >
            Manage prompts <ExternalLink className="size-3" />
          </Link>
        </div>
      </CardContent>
    </Card>
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
