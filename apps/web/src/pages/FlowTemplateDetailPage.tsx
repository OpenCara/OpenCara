import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { FlowGraph } from "@/components/flow/FlowGraph";
import { flowTemplateDetailQuery } from "@/lib/queries";

export function FlowTemplateDetailPage() {
  const { slug } = useParams();
  const q = useQuery(flowTemplateDetailQuery(slug!));

  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!q.data) {
    return (
      <div className="text-sm text-muted-foreground">Flow template not found.</div>
    );
  }
  const t = q.data.template;

  return (
    <div className="space-y-6">
      <div>
        <Link
          to="/flows"
          className="text-sm text-muted-foreground hover:text-foreground"
        >
          ← All templates
        </Link>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">
          {t.name}
          <Badge variant="outline" className="ml-2 align-middle">
            {t.slug}
          </Badge>
        </h2>
        <p className="text-sm text-muted-foreground">{t.description}</p>
      </div>

      <FlowGraph nodes={t.graphJson.nodes} edges={t.graphJson.edges} />

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium text-muted-foreground">
            Source
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            This is a read-only view of the template registered in{" "}
            <span className="font-mono">@openkira/flows</span>. To edit the graph
            shape (add/remove reviewers, rename a node, link an agent), open the
            project-scoped instance under{" "}
            <span className="font-mono">/projects/&lt;id&gt;/flows/{t.slug}</span>
            .
          </p>
          <div className="text-xs">
            {t.nodeCount} nodes · {t.edgeCount} edges
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
