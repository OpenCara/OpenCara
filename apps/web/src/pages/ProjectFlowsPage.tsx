import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { projectFlowsQuery } from "@/lib/queries";
import { formatRelative } from "@/lib/format";

export function ProjectFlowsPage() {
  const { id } = useParams();
  const q = useQuery(projectFlowsQuery(id!));

  if (q.isLoading) return <Skeleton className="h-32 w-full" />;
  const flows = q.data?.flows ?? [];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-xl font-semibold tracking-tight">Flows</h2>
        <p className="text-sm text-muted-foreground">
          Built-in flows attached to this project. Read-only in v1.
        </p>
      </div>
      {flows.length === 0 ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No flows. (Built-ins should be seeded automatically.)
        </div>
      ) : (
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
      )}
    </div>
  );
}
