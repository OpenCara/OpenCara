import { Fragment, useState, type FormEvent } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useNavigate, useParams } from "react-router";
import { ChevronDown, ChevronRight, ExternalLink } from "lucide-react";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  projectQuery,
  projectEventsQuery,
  projectFlowRunsQuery,
  projectFlowsQuery,
  projectIssuesQuery,
  projectRunsQuery,
  useSetProjectDefaultImplementFlow,
  useSetProjectInstructionsFile,
  useSyncProjectIssues,
  type FlowRunSummary,
  type FlowSummary,
} from "@/lib/queries";
import { formatRelative } from "@/lib/format";
import { summarizeEvent } from "@/lib/eventSummary";
import { KanbanTab } from "@/components/kanban/KanbanBoard";

export function ProjectDetailPage() {
  const { id, tab } = useParams();
  const navigate = useNavigate();
  const project = useQuery(projectQuery(id!));

  if (project.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!project.data) {
    return (
      <div className="text-sm text-muted-foreground">Project not found.</div>
    );
  }

  const p = project.data.project;
  const inst = project.data.installation;
  const ghUrl = `https://github.com/${p.owner}/${p.name}`;
  const activeTab = tab ?? "overview";

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">
            {p.owner}/{p.name}
          </h1>
          <p className="text-sm text-muted-foreground">
            via installation @{inst.accountLogin}
          </p>
        </div>
        <div className="flex items-center gap-4 text-sm">
          <Link
            to={`/projects/${id}/flows`}
            className="text-muted-foreground hover:text-foreground"
          >
            Flows →
          </Link>
          <a
            href={ghUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            GitHub <ExternalLink className="size-3.5" />
          </a>
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) =>
          navigate(`/projects/${id}${v === "overview" ? "" : `/${v}`}`)
        }
        className="min-w-0"
      >
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="issues">Issues</TabsTrigger>
          <TabsTrigger value="kanban">Kanban</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="flow-runs">Flow runs</TabsTrigger>
          <TabsTrigger value="runs">Agent runs</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
          <div className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle className="text-base font-medium text-muted-foreground">
                  Repository
                </CardTitle>
              </CardHeader>
              <CardContent className="grid grid-cols-2 gap-4 text-sm">
                <Field label="Default branch" value={p.defaultBranch ?? "—"} />
                <Field label="Visibility" value={p.private ? "Private" : "Public"} />
                <Field label="Installation account" value={inst.accountLogin} />
                <Field label="Account type" value={inst.accountType} />
                <Field label="Added" value={formatRelative(p.addedAt)} />
                <Field
                  label="Status"
                  value={
                    p.removedAt
                      ? "Removed"
                      : inst.suspendedAt
                        ? "Suspended"
                        : "Active"
                  }
                />
              </CardContent>
            </Card>
            <DefaultImplementFlowCard projectId={id!} currentFlowId={p.defaultImplementFlowId ?? null} />
            <InstructionsFileCard projectId={id!} current={p.instructionsFile ?? ""} />
          </div>
        </TabsContent>

        <TabsContent value="issues">
          <IssuesTab id={id!} />
        </TabsContent>

        <TabsContent value="kanban" className="min-w-0">
          <KanbanTab projectId={id!} />
        </TabsContent>

        <TabsContent value="events">
          <EventsTab id={id!} />
        </TabsContent>

        <TabsContent value="flow-runs">
          <FlowRunsTab id={id!} />
        </TabsContent>

        <TabsContent value="runs">
          <RunsTab id={id!} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="font-medium">{value}</div>
    </div>
  );
}

function EventsTab({ id }: { id: string }) {
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

function RunsTab({ id }: { id: string }) {
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

function FlowRunsTab({ id }: { id: string }) {
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
          Flows page
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

function IssuesTab({ id }: { id: string }) {
  const [stateFilter, setStateFilter] = useState<"open" | "closed" | "all">("open");
  const q = useQuery(projectIssuesQuery(id, { state: stateFilter }));
  const sync = useSyncProjectIssues(id);
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            State
          </span>
          <Select
            value={stateFilter}
            onValueChange={(v) => setStateFilter(v as "open" | "closed" | "all")}
          >
            <SelectTrigger className="h-8 w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="open">Open</SelectItem>
              <SelectItem value="closed">Closed</SelectItem>
              <SelectItem value="all">All</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground">
            {q.data?.issues.length ?? 0} shown
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={sync.isPending}
            onClick={() => sync.mutate()}
            title="Fetch all issues from GitHub. Useful for projects added before the issues feature shipped."
          >
            {sync.isPending ? "Syncing…" : "Sync from GitHub"}
          </Button>
        </div>
      </div>
      {sync.data && (
        <div className="text-xs text-muted-foreground">
          Synced: {sync.data.inserted} new, {sync.data.updated} updated,{" "}
          {sync.data.skipped} PRs skipped.
        </div>
      )}
      {sync.error && (
        <div className="text-xs text-destructive">
          Sync failed: {sync.error instanceof Error ? sync.error.message : String(sync.error)}
        </div>
      )}
      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : !q.data || q.data.issues.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No issues match this filter. Issues are populated from webhooks and
          backfilled when the project is added.
        </div>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-16">#</TableHead>
                  <TableHead>Title</TableHead>
                  <TableHead className="w-24">State</TableHead>
                  <TableHead>Labels</TableHead>
                  <TableHead>Assignees</TableHead>
                  <TableHead className="w-32">Updated</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {q.data.issues.map((issue) => (
                  <TableRow key={issue.id}>
                    <TableCell className="text-sm text-muted-foreground">
                      #{issue.number}
                    </TableCell>
                    <TableCell className="text-sm">
                      <div className="flex items-center gap-2">
                        <Link
                          to={`/projects/${id}/issues/${issue.number}`}
                          className="hover:underline"
                        >
                          {issue.title}
                        </Link>
                        <a
                          href={issue.htmlUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-muted-foreground hover:text-foreground"
                          title="Open on GitHub"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <ExternalLink className="size-3" />
                        </a>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={issue.state === "open" ? "default" : "secondary"}
                      >
                        {issue.state}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {issue.labels.map((l) => (
                          <Badge key={l.name} variant="outline" className="text-xs">
                            {l.name}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {issue.assignees.map((a) => `@${a.login}`).join(", ") || "—"}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatRelative(issue.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const NO_FLOW_VALUE = "__none";

function DefaultImplementFlowCard({
  projectId,
  currentFlowId,
}: {
  projectId: string;
  currentFlowId: string | null;
}) {
  const flowsQ = useQuery(projectFlowsQuery(projectId));
  const setDefault = useSetProjectDefaultImplementFlow(projectId);
  const flows = flowsQ.data?.flows ?? [];
  // Show the currently-selected flow even if it was later disabled, so the
  // user sees it in the dropdown and can explicitly change or clear it.
  const enabledOrCurrent = flows.filter((f) => f.enabled || f.id === currentFlowId);
  const value = currentFlowId ?? NO_FLOW_VALUE;

  const onSelect = (next: string) => {
    if (next === value) return;
    setDefault.mutate(next === NO_FLOW_VALUE ? null : next);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium text-muted-foreground">
          Implement flow
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-xs text-muted-foreground">
          Default flow triggered by the kanban card Start button. Only enabled
          flows are listed.
        </p>
        <Select
          value={value}
          onValueChange={onSelect}
          disabled={setDefault.isPending || flowsQ.isLoading}
        >
          <SelectTrigger className="h-8 w-64">
            <SelectValue placeholder="None" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NO_FLOW_VALUE}>None</SelectItem>
            {enabledOrCurrent.map((f) => (
                <SelectItem key={f.id} value={f.id}>
                  {f.name}{!f.enabled ? " (disabled)" : ""}
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
        {setDefault.error && (
          <div className="text-xs text-destructive">
            {setDefault.error instanceof Error
              ? setDefault.error.message
              : String(setDefault.error)}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "succeeded") return "default";
  if (s === "failed" || s === "cancelled") return "destructive";
  return "secondary";
}

function InstructionsFileCard({
  projectId,
  current,
}: {
  projectId: string;
  current: string;
}) {
  const setInstructionsFile = useSetProjectInstructionsFile(projectId);
  const [draft, setDraft] = useState(current);
  const trimmed = draft.trim();
  const dirty = trimmed !== current;
  // Mirror the server-side validation in `validateInstructionsFileInput`
  // so the operator sees rejection reasons inline instead of clicking
  // Save just to discover the value was bad. Empty string is allowed
  // (= disable injection for this project).
  const localError = (() => {
    if (trimmed.length === 0) return null;
    if (trimmed.startsWith("/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
      return "Must be a repo-relative path, not absolute.";
    }
    if (trimmed.split(/[\\/]/).includes("..")) {
      return "Must not contain '..' segments.";
    }
    if (!/\.md$/i.test(trimmed)) {
      return "Must end in .md.";
    }
    return null;
  })();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (localError || !dirty || setInstructionsFile.isPending) return;
    // Sync the input with the trimmed value before sending. Without
    // this, an operator typing "AGENTS.md  " saves the right value
    // ("AGENTS.md") on the server but the input keeps the trailing
    // spaces visible, making the disabled Save button look broken
    // ("the field is dirty but Save is greyed out").
    setDraft(trimmed);
    setInstructionsFile.mutate(trimmed);
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base font-medium text-muted-foreground">
          Agent instructions file
        </CardTitle>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="space-y-2 text-sm">
          <p className="text-xs text-muted-foreground">
            Repo-relative path. Read from the worktree at dispatch and
            injected as the canonical project system prompt for every
            agent — replaces each CLI's per-kind auto-discovery (e.g.{" "}
            <code className="font-mono">~/.claude/CLAUDE.md</code>) so the
            agent's instructions are identical across kinds. Leave empty
            to disable injection.
          </p>
          <Label
            htmlFor="instructions-file"
            className="text-xs uppercase tracking-wide text-muted-foreground"
          >
            File path
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id="instructions-file"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="AGENTS.md"
              className="h-8 max-w-md font-mono text-xs"
              spellCheck={false}
              autoComplete="off"
            />
            <Button
              type="submit"
              size="sm"
              variant="outline"
              disabled={
                !dirty || setInstructionsFile.isPending || localError !== null
              }
            >
              {setInstructionsFile.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
          {localError && (
            <div className="text-xs text-destructive">{localError}</div>
          )}
          {setInstructionsFile.error && !localError && (
            <div className="text-xs text-destructive">
              {setInstructionsFile.error instanceof Error
                ? setInstructionsFile.error.message
                : String(setInstructionsFile.error)}
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  );
}
