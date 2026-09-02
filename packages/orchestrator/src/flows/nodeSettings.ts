/**
 * Effective per-node settings for a project flow.
 *
 * The account-scope template (`template_node_settings`, keyed by the project
 * owner + template slug) is the DEFAULT for every project flow seeded from
 * it. A `flow_node_settings` row exists only where the project overrides the
 * template for that node; otherwise the template row applies. Every consumer
 * (engine, runner, chat, API, skills) resolves through here so the two
 * never disagree.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { flowNodeSettings, flows, projects, templateNodeSettings } from "../db/schema.js";

export type NodeSettingSource = "project" | "template";

export interface EffectiveNodeSetting {
  /** Project override row id when `source === "project"`, else null. */
  id: string | null;
  flowId: string;
  projectId: string;
  nodeId: string;
  promptId: string | null;
  agentId: string | null;
  fallbackAgentIds: string[];
  retrySame: number;
  concurrency: number;
  quorum: number;
  label: string | null;
  updatedAt: Date;
  source: NodeSettingSource;
}

type TemplateRow = typeof templateNodeSettings.$inferSelect;
type ProjectRow = typeof flowNodeSettings.$inferSelect;

/** Pure merge: project rows win per node, template rows fill the rest. */
export function mergeEffectiveSettings(
  ctx: { flowId: string; projectId: string },
  templateRows: readonly TemplateRow[],
  projectRows: readonly ProjectRow[],
): EffectiveNodeSetting[] {
  const out = new Map<string, EffectiveNodeSetting>();
  for (const t of templateRows) {
    out.set(t.nodeId, {
      id: null,
      flowId: ctx.flowId,
      projectId: ctx.projectId,
      nodeId: t.nodeId,
      promptId: t.promptId,
      agentId: t.agentId,
      fallbackAgentIds: t.fallbackAgentIds,
      retrySame: t.retrySame,
      concurrency: t.concurrency,
      quorum: t.quorum,
      label: t.label,
      updatedAt: t.updatedAt,
      source: "template",
    });
  }
  for (const p of projectRows) {
    out.set(p.nodeId, {
      id: p.id,
      flowId: p.flowId,
      projectId: p.projectId,
      nodeId: p.nodeId,
      promptId: p.promptId,
      agentId: p.agentId,
      fallbackAgentIds: p.fallbackAgentIds,
      retrySame: p.retrySame,
      concurrency: p.concurrency,
      quorum: p.quorum,
      label: p.label,
      updatedAt: p.updatedAt,
      source: "project",
    });
  }
  return [...out.values()];
}

/** Every effective node setting for a flow (template defaults + overrides). */
export async function loadEffectiveNodeSettings(
  db: Db,
  flowId: string,
): Promise<EffectiveNodeSetting[]> {
  const flow = await db.query.flows.findFirst({
    where: eq(flows.id, flowId),
    columns: { id: true, projectId: true, slug: true },
  });
  if (!flow) return [];
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, flow.projectId),
    columns: { addedByUserId: true },
  });
  const [templateRows, projectRows] = await Promise.all([
    project?.addedByUserId
      ? db.query.templateNodeSettings.findMany({
          where: and(
            eq(templateNodeSettings.userId, project.addedByUserId),
            eq(templateNodeSettings.templateSlug, flow.slug),
          ),
        })
      : Promise.resolve([] as TemplateRow[]),
    db.query.flowNodeSettings.findMany({ where: eq(flowNodeSettings.flowId, flowId) }),
  ]);
  return mergeEffectiveSettings(
    { flowId, projectId: flow.projectId },
    templateRows,
    projectRows,
  );
}

export async function loadEffectiveNodeSetting(
  db: Db,
  flowId: string,
  nodeId: string,
): Promise<EffectiveNodeSetting | null> {
  const all = await loadEffectiveNodeSettings(db, flowId);
  return all.find((s) => s.nodeId === nodeId) ?? null;
}

export interface TemplateOverrideSummary {
  projectId: string;
  owner: string;
  name: string;
  flowId: string;
  /** The project keeps its own graph (`flows.customized_at` set). */
  graphCustomized: boolean;
  /** Node ids with a project-level settings override (nodes still in the graph). */
  nodeOverrides: string[];
}

/**
 * Which of the user's projects diverge from the account-scope template for
 * `slug` — either by a customized graph or by per-node settings overrides.
 * Projects that fully inherit are omitted.
 */
export async function listTemplateOverrides(
  db: Db,
  userId: string,
  slug: string,
): Promise<TemplateOverrideSummary[]> {
  const rows = await db
    .select({
      projectId: projects.id,
      owner: projects.owner,
      name: projects.name,
      flowId: flows.id,
      customizedAt: flows.customizedAt,
      graphJson: flows.graphJson,
    })
    .from(flows)
    .innerJoin(projects, eq(projects.id, flows.projectId))
    .where(and(eq(projects.addedByUserId, userId), eq(flows.slug, slug)));
  const overrideRows =
    rows.length > 0
      ? await db
          .select({ flowId: flowNodeSettings.flowId, nodeId: flowNodeSettings.nodeId })
          .from(flowNodeSettings)
          .where(inArray(flowNodeSettings.flowId, rows.map((r) => r.flowId)))
      : [];
  const overridesByFlow = new Map<string, string[]>();
  for (const o of overrideRows) {
    const list = overridesByFlow.get(o.flowId) ?? [];
    list.push(o.nodeId);
    overridesByFlow.set(o.flowId, list);
  }
  const out: TemplateOverrideSummary[] = [];
  for (const r of rows) {
    const graphNodeIds = new Set(
      ((r.graphJson as { nodes?: Array<{ id: string }> })?.nodes ?? []).map((n) => n.id),
    );
    // Orphaned rows (nodes removed from the graph, e.g. legacy reviewer_*)
    // are inert and would only confuse the listing.
    const nodeOverrides = (overridesByFlow.get(r.flowId) ?? []).filter((id) => graphNodeIds.has(id));
    const graphCustomized = r.customizedAt !== null;
    if (!graphCustomized && nodeOverrides.length === 0) continue;
    out.push({
      projectId: r.projectId,
      owner: r.owner,
      name: r.name,
      flowId: r.flowId,
      graphCustomized,
      nodeOverrides: nodeOverrides.sort(),
    });
  }
  return out.sort((a, b) => `${a.owner}/${a.name}`.localeCompare(`${b.owner}/${b.name}`));
}
