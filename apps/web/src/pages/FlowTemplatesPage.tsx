import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Workflow } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { flowTemplatesQuery } from "@/lib/queries";

export function FlowTemplatesPage() {
  const q = useQuery(flowTemplatesQuery());

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Flow templates</h1>
        <p className="text-sm text-muted-foreground">
          Built-in flow definitions registered in code. Each project receives
          its own editable instance of every template; this page is for
          inspecting the source-of-truth shapes.
        </p>
      </div>

      {q.isLoading ? (
        <Skeleton className="h-32 w-full" />
      ) : !q.data?.templates.length ? (
        <div className="py-12 text-center text-sm text-muted-foreground">
          No templates registered.
        </div>
      ) : (
        <div className="grid gap-3 md:grid-cols-2">
          {q.data.templates.map((t) => (
            <Link key={t.slug} to={`/flows/${t.slug}`} className="block">
              <Card className="transition-colors hover:bg-secondary/40">
                <CardHeader>
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="text-base">
                      <Workflow className="mr-1.5 inline-block size-4 text-muted-foreground" />
                      {t.name}
                    </CardTitle>
                    <Badge variant="outline">{t.slug}</Badge>
                  </div>
                </CardHeader>
                <CardContent className="space-y-2 text-sm text-muted-foreground">
                  <p>{t.description}</p>
                  <div className="text-xs">
                    {t.nodeCount} nodes · {t.edgeCount} edges
                  </div>
                </CardContent>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
