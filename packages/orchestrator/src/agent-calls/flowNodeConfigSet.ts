import { and, eq } from "drizzle-orm";
import { FlowDefinitionSchema } from "@opencara/flows";
import type { FlowNodeConfigSetCall } from "@opencara/shared";
import type { Db } from "../db/client.js";
import { flows } from "../db/schema.js";
import type { AgentCallResult } from "./index.js";

/**
 * Apply a `flow.node.config.set` agent-call. Mirrors PATCH
 * /projects/:projectId/flows/:flowId/nodes/:nodeId/config (flows.ts:83-143):
 * resolve flow by (projectId, slug), substitute the node's config, validate
 * the candidate graph, and persist with `customizedAt` so the seeder
 * doesn't clobber the edit.
 */
export async function applyFlowNodeConfigSet(
  db: Db,
  projectId: string,
  msg: Pick<FlowNodeConfigSetCall, "flowSlug" | "nodeId" | "config">,
): Promise<AgentCallResult> {
  const flow = await db.query.flows.findFirst({
    where: and(eq(flows.projectId, projectId), eq(flows.slug, msg.flowSlug)),
  });
  if (!flow) return { ok: false, reason: `flow ${msg.flowSlug} not in project` };

  const graph = parseGraph(flow.graphJson);
  if (!graph) return { ok: false, reason: "flow graph invalid" };

  const target = graph.nodes.find((n) => n.id === msg.nodeId);
  if (!target) return { ok: false, reason: `node ${msg.nodeId} not in flow` };

  target.config = msg.config as typeof target.config;

  const validation = FlowDefinitionSchema.safeParse({
    slug: flow.slug,
    name: flow.name,
    description: (flow.graphJson as { description?: string })?.description ?? "",
    nodes: graph.nodes,
    edges: graph.edges,
  });
  if (!validation.success) {
    const issue = validation.error.issues[0];
    return {
      ok: false,
      reason: `invalid config: ${issue?.path.join(".") ?? ""} ${issue?.message ?? "validation failed"}`,
    };
  }

  await db
    .update(flows)
    .set({
      graphJson: graph,
      customizedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(eq(flows.id, flow.id));
  return { ok: true };
}

interface MutableGraph {
  nodes: Array<{
    id: string;
    kind: string;
    position: { x: number; y: number };
    config?: { label?: string };
    [key: string]: unknown;
  }>;
  edges: Array<{ id: string; source: string; target: string }>;
  description?: string;
}

function parseGraph(raw: unknown): MutableGraph | null {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as MutableGraph;
  if (!Array.isArray(g.nodes) || !Array.isArray(g.edges)) return null;
  return JSON.parse(JSON.stringify(g)) as MutableGraph;
}
