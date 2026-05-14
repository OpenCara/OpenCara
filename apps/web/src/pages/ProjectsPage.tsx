import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Trash2 } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import {
  projectsQuery,
  useRemoveProject,
  type ProjectListItem,
} from "@/lib/queries";
import { formatRelative } from "@/lib/format";

export function ProjectsPage() {
  const { data, isLoading } = useQuery(projectsQuery());

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">
            Repositories OpenCara is currently watching.
          </p>
        </div>
        <Link to="/projects/new">
          <Button>Add project</Button>
        </Link>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base font-medium text-muted-foreground">
            All projects
          </CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : !data || data.projects.length === 0 ? (
            <div className="py-12 text-center text-sm text-muted-foreground">
              No projects yet.{" "}
              <Link to="/projects/new" className="text-foreground underline">
                Add your first one
              </Link>
              .
            </div>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Installation</TableHead>
                  <TableHead>Last event</TableHead>
                  <TableHead>Runs (7d)</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.projects.map((p) => (
                  <ProjectRow key={p.id} project={p} />
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function ProjectRow({ project }: { project: ProjectListItem }) {
  const remove = useRemoveProject();
  const isRemoved = !!project.removedAt;
  return (
    <TableRow>
      <TableCell className="font-medium">
        <Link to={`/projects/${project.id}`} className="hover:underline">
          {project.owner}/{project.name}
        </Link>
        {project.private && (
          <Badge variant="secondary" className="ml-2">
            private
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-sm text-muted-foreground">
        {project.installationAccountLogin}
      </TableCell>
      <TableCell className="text-sm">
        {project.lastEventAt ? formatRelative(project.lastEventAt) : "—"}
      </TableCell>
      <TableCell className="text-sm">{project.recentRunsCount}</TableCell>
      <TableCell>
        <StatusBadge project={project} />
      </TableCell>
      <TableCell className="text-right">
        {!isRemoved && (
          <Button
            size="sm"
            variant="ghost"
            disabled={remove.isPending}
            onClick={() => {
              if (
                window.confirm(
                  `Remove project "${project.owner}/${project.name}"? OpenCara will stop watching this repo.`,
                )
              ) {
                remove.mutate(project.id);
              }
            }}
            aria-label="Remove project"
          >
            <Trash2 className="size-4" />
          </Button>
        )}
      </TableCell>
    </TableRow>
  );
}

function StatusBadge({ project }: { project: ProjectListItem }) {
  if (project.removedAt) return <Badge variant="outline">removed</Badge>;
  if (project.installationSuspendedAt) return <Badge variant="destructive">suspended</Badge>;
  return <Badge>active</Badge>;
}
