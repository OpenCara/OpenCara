import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Badge } from "@/components/ui/badge";
import { FlowGraph } from "@/components/flow/FlowGraph";
import { NodeEditor, type EditorScope } from "@/components/flow/NodeEditor";
import {
  agentsQuery,
  flowTemplateDetailQuery,
  promptsQuery,
} from "@/lib/queries";

export function FlowTemplateDetailPage() {
  const { slug } = useParams();
  const q = useQuery(flowTemplateDetailQuery(slug!));
  const promptsQ = useQuery(promptsQuery());
  const agentsQ = useQuery(agentsQuery());
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);

  if (q.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!q.data) {
    return (
      <div className="text-sm text-muted-foreground">Flow template not found.</div>
    );
  }
  const t = q.data.template;
  // Defensive: an older backend may not include `settings` / `hasDraft` yet.
  const settings = q.data.settings ?? [];
  const hasDraft = q.data.hasDraft ?? false;
  const prompts = promptsQ.data?.prompts ?? [];
  const agents = agentsQ.data?.agents ?? [];

  const selectedNode = selectedNodeId
    ? t.graphJson.nodes.find((n) => n.id === selectedNodeId) ?? null
    : null;

  const labelOverrides = Object.fromEntries(
    settings.filter((s) => s.label).map((s) => [s.nodeId, s.label as string]),
  );

  const isMultiReview = t.slug === "pr-review-multi";
  const scope: EditorScope = { kind: "template", slug: t.slug };

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
          {hasDraft && (
            <Badge variant="secondary" className="ml-2 align-middle">
              customized
            </Badge>
          )}
        </h2>
        <p className="text-sm text-muted-foreground">{t.description}</p>
      </div>

      <FlowGraph
        nodes={t.graphJson.nodes}
        edges={t.graphJson.edges}
        labelOverrides={labelOverrides}
        onNodeClick={(nid) => setSelectedNodeId(nid)}
      />

      <NodeEditor
        scope={scope}
        graph={t.graphJson}
        selectedNode={selectedNode}
        settings={settings}
        agents={agents}
        prompts={prompts}
        showReviewerControls={isMultiReview}
        onSelectedNodeRemoved={() => setSelectedNodeId(null)}
        onClose={() => setSelectedNodeId(null)}
      />

      <Card>
        <CardHeader>
          <CardTitle className="text-base font-medium text-muted-foreground">
            About templates
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>
            Edits here are saved to your account and used as defaults when a new
            project flow is created from this template. Existing project flows
            are not affected — open a project's{" "}
            <span className="font-mono">/flows/{t.slug}</span> to override
            settings just for that project.
          </p>
          <div className="text-xs">
            {t.nodeCount} nodes · {t.edgeCount} edges
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
