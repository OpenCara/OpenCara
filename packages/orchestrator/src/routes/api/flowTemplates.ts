import { Hono } from "hono";
import { ulid } from "ulid";
import { and, eq } from "drizzle-orm";
import { builtinFlows, FlowDefinitionSchema, type FlowDefinition } from "@opencara/flows";
import type { Db } from "../../db/client.js";
import {
  agents,
  prompts,
  templateDrafts,
  templateNodeSettings,
} from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";

interface FlowTemplateRoutesDeps {
  db: Db;
}

/**
 * Catalog + per-user editor for built-in flow templates.
 *
 * Each template (registered in @opencara/flows) is the read-only seed. On
 * first edit, we materialise a per-user `template_drafts` row that overlays
 * the code template's graphJson; subsequent edits write to that row. The
 * project flow seeder reads the project owner's draft (when present) so a
 * newly created project flow picks up whatever the user configured here.
 */
export function flowTemplateRoutes(deps: FlowTemplateRoutesDeps) {
  const r = new Hono<AuthEnv>();
  const auth = requireUser();

  r.get("/flow-templates", auth, (c) => {
    const templates = Object.values(builtinFlows).map(toSummary);
    return c.json({ templates });
  });

  r.get("/flow-templates/:slug", auth, async (c) => {
    const user = c.get("user")!;
    const slug = c.req.param("slug");
    const def = builtinFlows[slug];
    if (!def) return c.json({ error: "not found" }, 404);

    const draft = await deps.db.query.templateDrafts.findFirst({
      where: and(
        eq(templateDrafts.userId, user.id),
        eq(templateDrafts.templateSlug, slug),
      ),
    });
    const graph = draft ? (draft.graphJson as MutableGraph) : codeGraph(def);
    const settings = await deps.db
      .select()
      .from(templateNodeSettings)
      .where(
        and(
          eq(templateNodeSettings.userId, user.id),
          eq(templateNodeSettings.templateSlug, slug),
        ),
      );

    return c.json({
      template: {
        ...toSummary(def),
        graphJson: graph,
      },
      hasDraft: !!draft,
      customizedAt: draft?.customizedAt ?? null,
      settings,
    });
  });

  r.get("/flow-templates/:slug/node-settings", auth, async (c) => {
    const user = c.get("user")!;
    const slug = c.req.param("slug");
    if (!builtinFlows[slug]) return c.json({ error: "not found" }, 404);
    const rows = await deps.db
      .select()
      .from(templateNodeSettings)
      .where(
        and(
          eq(templateNodeSettings.userId, user.id),
          eq(templateNodeSettings.templateSlug, slug),
        ),
      );
    return c.json({ settings: rows });
  });

  r.patch("/flow-templates/:slug/nodes/:nodeId/config", auth, async (c) => {
    const user = c.get("user")!;
    const slug = c.req.param("slug");
    const nodeId = c.req.param("nodeId");
    const def = builtinFlows[slug];
    if (!def) return c.json({ error: "not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    if (!body.config || typeof body.config !== "object") {
      return c.json({ error: "config (object) required" }, 400);
    }

    const draft = await loadOrCloneDraft(deps.db, user.id, def);
    const graph = JSON.parse(JSON.stringify(draft.graphJson)) as MutableGraph;
    const target = graph.nodes.find((n) => n.id === nodeId);
    if (!target) return c.json({ error: "node not found" }, 404);
    target.config = body.config as typeof target.config;

    const validation = validateGraph(def, graph);
    if (!validation.ok) return c.json({ error: validation.error }, 400);

    await deps.db
      .update(templateDrafts)
      .set({
        graphJson: graph,
        customizedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(templateDrafts.id, draft.id));
    return c.json({
      template: {
        ...toSummary(def),
        graphJson: graph,
      },
      hasDraft: true,
    });
  });

  r.put("/flow-templates/:slug/nodes/:nodeId/settings", auth, async (c) => {
    const user = c.get("user")!;
    const slug = c.req.param("slug");
    const nodeId = c.req.param("nodeId");
    if (!builtinFlows[slug]) return c.json({ error: "not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const promptId = parseKeepable(body.promptId);
    const agentId = parseKeepable(body.agentId);
    const labelRaw = body.label;
    const label: string | null | typeof KEEP =
      labelRaw === undefined
        ? KEEP
        : labelRaw === null
          ? null
          : String(labelRaw).trim() || null;

    if (promptId && promptId !== KEEP) {
      const p = await deps.db.query.prompts.findFirst({
        where: and(eq(prompts.id, promptId), eq(prompts.userId, user.id)),
      });
      if (!p) return c.json({ error: "prompt not found" }, 404);
    }
    if (agentId && agentId !== KEEP) {
      const a = await deps.db.query.agents.findFirst({
        where: and(eq(agents.id, agentId), eq(agents.userId, user.id)),
      });
      if (!a) return c.json({ error: "agent not found" }, 404);
    }

    const existing = await deps.db.query.templateNodeSettings.findFirst({
      where: and(
        eq(templateNodeSettings.userId, user.id),
        eq(templateNodeSettings.templateSlug, slug),
        eq(templateNodeSettings.nodeId, nodeId),
      ),
    });
    if (existing) {
      const patch: Partial<typeof templateNodeSettings.$inferInsert> = {
        updatedAt: new Date(),
      };
      if (promptId !== KEEP) patch.promptId = promptId;
      if (agentId !== KEEP) patch.agentId = agentId;
      if (label !== KEEP) patch.label = label;
      await deps.db
        .update(templateNodeSettings)
        .set(patch)
        .where(eq(templateNodeSettings.id, existing.id));
      const merged = {
        ...existing,
        ...(promptId !== KEEP ? { promptId } : {}),
        ...(agentId !== KEEP ? { agentId } : {}),
        ...(label !== KEEP ? { label } : {}),
        updatedAt: new Date().toISOString(),
      };
      return c.json({ setting: merged });
    }
    const id = ulid();
    const row = {
      id,
      userId: user.id,
      templateSlug: slug,
      nodeId,
      promptId: promptId === KEEP ? null : promptId,
      agentId: agentId === KEEP ? null : agentId,
      label: label === KEEP ? null : label,
    };
    await deps.db.insert(templateNodeSettings).values(row);
    return c.json({ setting: row }, 201);
  });

  r.post("/flow-templates/:slug/reviewers", auth, async (c) => {
    const user = c.get("user")!;
    const slug = c.req.param("slug");
    const def = builtinFlows[slug];
    if (!def) return c.json({ error: "not found" }, 404);

    const draft = await loadOrCloneDraft(deps.db, user.id, def);
    const graph = JSON.parse(JSON.stringify(draft.graphJson)) as MutableGraph;
    const result = addReviewer(graph);
    if (!result.ok) return c.json({ error: result.error }, 400);

    const validation = validateGraph(def, graph);
    if (!validation.ok) return c.json({ error: validation.error }, 400);

    await deps.db
      .update(templateDrafts)
      .set({
        graphJson: graph,
        customizedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(templateDrafts.id, draft.id));
    return c.json({
      template: { ...toSummary(def), graphJson: graph },
      addedNodeId: result.addedNodeId,
      hasDraft: true,
    });
  });

  r.delete("/flow-templates/:slug/reviewers/:nodeId", auth, async (c) => {
    const user = c.get("user")!;
    const slug = c.req.param("slug");
    const nodeId = c.req.param("nodeId");
    const def = builtinFlows[slug];
    if (!def) return c.json({ error: "not found" }, 404);

    const draft = await loadOrCloneDraft(deps.db, user.id, def);
    const graph = JSON.parse(JSON.stringify(draft.graphJson)) as MutableGraph;
    const result = removeReviewer(graph, nodeId);
    if (!result.ok) return c.json({ error: result.error }, 400);

    const validation = validateGraph(def, graph);
    if (!validation.ok) return c.json({ error: validation.error }, 400);

    await deps.db
      .update(templateDrafts)
      .set({
        graphJson: graph,
        customizedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(templateDrafts.id, draft.id));

    // Mirror project route: clear per-node settings for the orphaned node so
    // a re-added node with the same id starts clean.
    await deps.db
      .delete(templateNodeSettings)
      .where(
        and(
          eq(templateNodeSettings.userId, user.id),
          eq(templateNodeSettings.templateSlug, slug),
          eq(templateNodeSettings.nodeId, nodeId),
        ),
      );

    return c.json({
      template: { ...toSummary(def), graphJson: graph },
      hasDraft: true,
    });
  });

  return r;
}

function toSummary(def: FlowDefinition) {
  return {
    slug: def.slug,
    name: def.name,
    description: def.description,
    nodeCount: def.nodes.length,
    edgeCount: def.edges.length,
  };
}

function codeGraph(def: FlowDefinition): MutableGraph {
  return {
    nodes: JSON.parse(JSON.stringify(def.nodes)),
    edges: JSON.parse(JSON.stringify(def.edges)),
    description: def.description,
  };
}

async function loadOrCloneDraft(
  db: Db,
  userId: string,
  def: FlowDefinition,
): Promise<{ id: string; graphJson: MutableGraph }> {
  const existing = await db.query.templateDrafts.findFirst({
    where: and(
      eq(templateDrafts.userId, userId),
      eq(templateDrafts.templateSlug, def.slug),
    ),
  });
  if (existing) {
    return { id: existing.id, graphJson: existing.graphJson as MutableGraph };
  }
  const id = ulid();
  const graphJson = codeGraph(def);
  await db.insert(templateDrafts).values({
    id,
    userId,
    templateSlug: def.slug,
    graphJson,
    customizedAt: new Date(),
  });
  return { id, graphJson };
}

function validateGraph(
  def: FlowDefinition,
  graph: MutableGraph,
): { ok: true } | { ok: false; error: string } {
  const result = FlowDefinitionSchema.safeParse({
    slug: def.slug,
    name: def.name,
    description: graph.description ?? def.description,
    nodes: graph.nodes,
    edges: graph.edges,
  });
  if (result.success) return { ok: true };
  const issue = result.error.issues[0];
  return {
    ok: false,
    error: `invalid graph: ${issue?.path.join(".") ?? ""} ${issue?.message ?? "validation failed"}`,
  };
}

interface ReviewerOk {
  ok: true;
  addedNodeId: string;
}
interface ReviewerErr {
  ok: false;
  error: string;
}
function addReviewer(graph: MutableGraph): ReviewerOk | ReviewerErr {
  const trigger = graph.nodes.find((n) => n.kind === "github.pull_request");
  const synth = graph.nodes.find(
    (n) => n.kind === "agent" && (n.id === "synthesizer" || /synth/i.test(n.id)),
  );
  if (!trigger || !synth) {
    return {
      ok: false,
      error: "flow shape not supported (need a trigger and a synthesizer node)",
    };
  }
  const reviewerNodes = graph.nodes.filter(
    (n) =>
      n.kind === "agent" &&
      graph.edges.some((e) => e.source === trigger.id && e.target === n.id) &&
      graph.edges.some((e) => e.source === n.id && e.target === synth.id),
  );
  const template = reviewerNodes[0];
  if (!template) {
    return {
      ok: false,
      error: "no reviewer node to clone — add the first one in code",
    };
  }
  const newId = `reviewer_${ulid().slice(-8).toLowerCase()}`;
  const newNode = {
    ...JSON.parse(JSON.stringify(template)),
    id: newId,
    position: {
      x: template.position.x,
      y: Math.max(...reviewerNodes.map((r) => r.position.y)) + 160,
    },
  };
  if (newNode.config && typeof newNode.config === "object") {
    newNode.config.label = `Reviewer ${reviewerNodes.length + 1}`;
  }
  graph.nodes.push(newNode);
  graph.edges.push(
    { id: `e_t_${newId}`, source: trigger.id, target: newId },
    { id: `e_${newId}_s`, source: newId, target: synth.id },
  );
  return { ok: true, addedNodeId: newId };
}

function removeReviewer(
  graph: MutableGraph,
  nodeId: string,
): { ok: true } | ReviewerErr {
  const trigger = graph.nodes.find((n) => n.kind === "github.pull_request");
  const synth = graph.nodes.find(
    (n) => n.kind === "agent" && (n.id === "synthesizer" || /synth/i.test(n.id)),
  );
  if (!trigger || !synth) {
    return { ok: false, error: "flow shape not supported" };
  }
  const reviewerIds = new Set(
    graph.nodes
      .filter(
        (n) =>
          n.kind === "agent" &&
          graph.edges.some((e) => e.source === trigger.id && e.target === n.id) &&
          graph.edges.some((e) => e.source === n.id && e.target === synth.id),
      )
      .map((n) => n.id),
  );
  if (!reviewerIds.has(nodeId)) {
    return { ok: false, error: "node is not a reviewer in this flow" };
  }
  if (reviewerIds.size <= 1) {
    return {
      ok: false,
      error: "cannot remove the last reviewer — synthesizer would have no input",
    };
  }
  graph.nodes = graph.nodes.filter((n) => n.id !== nodeId);
  graph.edges = graph.edges.filter(
    (e) => e.source !== nodeId && e.target !== nodeId,
  );
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

const KEEP = "__keep__" as const;
function parseKeepable(raw: unknown): string | null | typeof KEEP {
  if (raw === undefined) return KEEP;
  if (raw === null) return null;
  return String(raw);
}
