import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import { ExternalLink } from "lucide-react";
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
import {
  projectQuery,
  projectFlowsQuery,
  projectIssuesQuery,
  useSyncProjectIssues,
} from "@/lib/queries";
import { formatRelative } from "@/lib/format";
import { KanbanTab } from "@/components/kanban/KanbanBoard";
import { ActivityTab } from "@/components/canvas/ActivityTab";
import { ProjectSettingsSheet } from "@/components/canvas/ProjectSettingsSheet";

const DEFAULT_TAB = "board";
const VALID_TABS = new Set(["board", "issues", "flows", "activity"]);

// Old tab URLs from the pre-#140 six-tab layout. Map each to its new
// equivalent so bookmarks and in-app links keep resolving. Empty target
// = the default Board tab at the project base path. The three
// observability aliases carry a `view` so Activity opens on the matching
// sub-filter pill.
const TAB_ALIASES: Record<string, string> = {
  overview: "",
  kanban: "",
  events: "activity?view=events",
  runs: "activity?view=runs",
  "flow-runs": "activity?view=flow-runs",
};

export function ProjectDetailPage() {
  const { id, tab } = useParams();
  const navigate = useNavigate();
  const project = useQuery(projectQuery(id!));

  // Redirect legacy tab URLs before doing anything else — this only
  // depends on the path, not the fetched project.
  if (tab !== undefined && tab in TAB_ALIASES) {
    const target = TAB_ALIASES[tab];
    return (
      <Navigate to={`/projects/${id}${target ? `/${target}` : ""}`} replace />
    );
  }

  if (project.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!project.data) {
    return (
      <div className="text-sm text-muted-foreground">Project not found.</div>
    );
  }

  const p = project.data.project;
  const inst = project.data.installation;
  const ghUrl = `https://github.com/${p.owner}/${p.name}`;
  const activeTab = tab && VALID_TABS.has(tab) ? tab : DEFAULT_TAB;

  const status = p.removedAt
    ? "Removed"
    : inst.suspendedAt
      ? "Suspended"
      : "Active";
  // Compact one-line repo summary replacing the old read-only Overview
  // card: `main · Private · @login · Active`.
  const metaParts = [
    p.defaultBranch ?? "—",
    p.private ? "Private" : "Public",
    `@${inst.accountLogin}`,
    status,
  ];

  return (
    <div className="min-w-0 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            {p.owner}/{p.name}
          </h1>
          <p className="truncate text-sm text-muted-foreground">
            {metaParts.join(" · ")}
          </p>
        </div>
        <div className="flex items-center gap-2 text-sm">
          <a
            href={ghUrl}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 text-muted-foreground hover:text-foreground"
          >
            GitHub <ExternalLink className="size-3.5" />
          </a>
          <ProjectSettingsSheet
            projectId={id!}
            defaultImplementFlowId={p.defaultImplementFlowId ?? null}
            instructionsFile={p.instructionsFile ?? ""}
          />
        </div>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) =>
          navigate(`/projects/${id}${v === DEFAULT_TAB ? "" : `/${v}`}`)
        }
        className="min-w-0"
      >
        <TabsList>
          <TabsTrigger value="board">Board</TabsTrigger>
          <TabsTrigger value="issues">Issues</TabsTrigger>
          <TabsTrigger value="flows">Flows</TabsTrigger>
          <TabsTrigger value="activity">Activity</TabsTrigger>
        </TabsList>

        <TabsContent value="board" className="min-w-0">
          <KanbanTab projectId={id!} />
        </TabsContent>

        <TabsContent value="issues">
          <IssuesTab id={id!} />
        </TabsContent>

        <TabsContent value="flows">
          <FlowsTab id={id!} />
        </TabsContent>

        <TabsContent value="activity">
          <ActivityTab id={id!} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function FlowsTab({ id }: { id: string }) {
  const q = useQuery(projectFlowsQuery(id));
  if (q.isLoading) return <Skeleton className="h-32 w-full" />;
  const flows = q.data?.flows ?? [];

  if (flows.length === 0) {
    return (
      <div className="py-12 text-center text-sm text-muted-foreground">
        No flows. (Built-ins should be seeded automatically.)
      </div>
    );
  }
  return (
    <div className="grid gap-4 md:grid-cols-2">
      {flows.map((f) => (
        <Link key={f.id} to={`/projects/${id}/flows/${f.slug}`}>
          <Card className="transition hover:bg-secondary/30">
            <CardHeader>
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">{f.name}</CardTitle>
                <Badge variant={f.enabled ? "default" : "outline"}>
                  {f.enabled ? "enabled" : "disabled"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="text-sm text-muted-foreground">
              {f.graphJson.description ?? `Flow with ${f.graphJson.nodes.length} nodes.`}
              <div className="mt-2 text-xs">Updated {formatRelative(f.updatedAt)}</div>
            </CardContent>
          </Card>
        </Link>
      ))}
    </div>
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
