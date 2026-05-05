import { and, eq } from "drizzle-orm";
import { ulid } from "ulid";
import {
  builtinFlows,
  FlowDefinitionSchema,
  type FlowDefinition,
} from "@opencara/flows";
import type { TemplateNodeConfigSetCall } from "@opencara/shared";
import type { Db } from "../db/client.js";
import { templateDrafts } from "../db/schema.js";
import type { AgentCallResult } from "./index.js";

/**
 * Apply a `template.node.config.set` agent-call. Mirrors PATCH
 * /flow-templates/:slug/nodes/:nodeId/config (flowTemplates.ts:85-109).
 *
 * Templates are per-user drafts: the call must carry a userId (the chat
 * dispatcher threads it in via RunContext.userId). Mutations land in the
 * user's `template_drafts` row, never on the published code template.
 */
export async function applyTemplateNodeConfigSet(
  db: Db,
  userId: string,
  msg: Pick<TemplateNodeConfigSetCall, "templateSlug" | "nodeId" | "config">,
): Promise<AgentCallResult> {
  const def = builtinFlows[msg.templateSlug];
  if (!def) return { ok: false, reason: `template ${msg.templateSlug} not found` };

  const graph = await currentGraph(db, userId, def);
  const target = graph.nodes.find((n) => n.id === msg.nodeId);
  if (!target) return { ok: false, reason: `node ${msg.nodeId} not in template` };
  target.config = msg.config as typeof target.config;

  const result = FlowDefinitionSchema.safeParse({
    slug: def.slug,
    name: def.name,
    description: graph.description ?? def.description,
    nodes: graph.nodes,
    edges: graph.edges,
  });
  if (!result.success) {
    const issue = result.error.issues[0];
    return {
      ok: false,
      reason: `invalid graph: ${issue?.path.join(".") ?? ""} ${issue?.message ?? "validation failed"}`,
    };
  }

  await persistDraft(db, userId, def.slug, graph);
  return { ok: true };
}

interface MutableGraph {
  nodes: Array<{
    id: string;
    kind: string;
    position: { x: number; y: number };
    config?: { label?: string } & Record<string, unknown>;
    [key: string]: unknown;
  }>;
  edges: Array<{ id: string; source: string; target: string }>;
  description?: string;
}

function codeGraph(def: FlowDefinition): MutableGraph {
  return {
    nodes: JSON.parse(JSON.stringify(def.nodes)),
    edges: JSON.parse(JSON.stringify(def.edges)),
    description: def.description,
  };
}

async function currentGraph(
  db: Db,
  userId: string,
  def: FlowDefinition,
): Promise<MutableGraph> {
  const draft = await db.query.templateDrafts.findFirst({
    where: and(
      eq(templateDrafts.userId, userId),
      eq(templateDrafts.templateSlug, def.slug),
    ),
  });
  if (draft) {
    return JSON.parse(JSON.stringify(draft.graphJson)) as MutableGraph;
  }
  return codeGraph(def);
}

async function persistDraft(
  db: Db,
  userId: string,
  slug: string,
  graph: MutableGraph,
): Promise<void> {
  const now = new Date();
  await db
    .insert(templateDrafts)
    .values({
      id: ulid(),
      userId,
      templateSlug: slug,
      graphJson: graph,
      customizedAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [templateDrafts.userId, templateDrafts.templateSlug],
      set: {
        graphJson: graph,
        customizedAt: now,
        updatedAt: now,
      },
    });
}
