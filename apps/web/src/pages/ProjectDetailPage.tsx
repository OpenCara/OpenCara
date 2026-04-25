import { Fragment, useState } from "react";
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
  projectQuery,
  projectEventsQuery,
  projectRunsQuery,
} from "@/lib/queries";
import { formatRelative } from "@/lib/format";
import { summarizeEvent } from "@/lib/eventSummary";

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
    <div className="space-y-6">
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
      >
        <TabsList>
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="events">Events</TabsTrigger>
          <TabsTrigger value="runs">Runs</TabsTrigger>
        </TabsList>

        <TabsContent value="overview">
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
        </TabsContent>

        <TabsContent value="events">
          <EventsTab id={id!} />
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

function statusVariant(s: string): "default" | "secondary" | "destructive" | "outline" {
  if (s === "succeeded") return "default";
  if (s === "failed" || s === "cancelled") return "destructive";
  return "secondary";
}
