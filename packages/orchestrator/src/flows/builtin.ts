import { ulid } from "ulid";
import { eq, and, inArray, isNull } from "drizzle-orm";
import { builtinFlows, developmentLifecycleFlow, type FlowDefinition } from "@opencara/flows";
import type { Db } from "../db/client.js";
import {
  POOL_REVIEWER_NODE_ID,
  foldLegacyReviewerSettings,
  graphHasPoolReviewer,
} from "./legacyReviewerPool.js";
import { loadEffectiveNodeSetting } from "./nodeSettings.js";
import {
  flowNodeSettings,
  flows,
  projects,
  templateDrafts,
  templateNodeSettings,
} from "../db/schema.js";

interface BuiltinGraph {
  nodes: FlowDefinition["nodes"];
  edges: FlowDefinition["edges"];
  description: string;
}

/**
 * Seed (or refresh) the project's per-flow rows for every builtin template.
 *
 * If the project owner has a `template_drafts` row for a given template, that
 * draft's graphJson is used as the seed instead of the code template — so the
 * project starts off matching whatever the user configured on the template
 * page, and keeps tracking it until the project customizes its graph. Node
 * settings are never copied: the owner's `template_node_settings` apply live
 * unless the project overrides a node (flows/nodeSettings.ts).
 */
export async function ensureBuiltinFlowsForProject(db: Db, projectId: string): Promise<void> {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { id: true, addedByUserId: true, defaultImplementFlowId: true },
  });
  const ownerUserId = project?.addedByUserId ?? null;
  // One-time split of the legacy unified template into the four stage
  // templates — drafts + node settings by node id — before seeding from them.
  if (ownerUserId) await splitLegacyLifecycleTemplates(db, ownerUserId);
  // Retire the project's legacy unified flow BEFORE the loop so the stage rows
  // it re-enables are back on the inheritance path when their graph refreshes.
  const retiredLegacyFlowId = await retireLegacyLifecycleFlow(db, projectId);

  for (const slug of Object.keys(builtinFlows)) {
    const def = builtinFlows[slug]!;
    const seed = await resolveSeedGraph(db, def, ownerUserId);
    const existing = await db.query.flows.findFirst({
      where: and(eq(flows.projectId, projectId), eq(flows.slug, slug)),
    });

    let flowId: string;
    let didInsert = false;
    if (existing) {
      flowId = existing.id;
      // Don't clobber a graph the user has edited inside the project (rename
      // / add / remove reviewer). The customizedAt sentinel is set by the
      // graph-mutation routes; until then, keep the seed in sync with the
      // resolved source (template draft or code template).
      if (!existing.customizedAt) {
        await db
          .update(flows)
          .set({
            name: def.name,
            graphJson: seed,
            updatedAt: new Date(),
          })
          .where(eq(flows.id, existing.id));
      }
    } else {
      flowId = ulid();
      didInsert = true;
      await db.insert(flows).values({
        id: flowId,
        projectId,
        slug,
        name: def.name,
        graphJson: seed,
        enabled: true,
      });
    }

    // Node settings are NOT copied: a fresh project inherits the owner's
    // template_node_settings live (flows/nodeSettings.ts) until it overrides
    // a node. `didInsert` is kept for the fold below.
    void didInsert;
    // A customized flow keeps its own graph, so judge the fold on what the
    // flow actually runs, not on the seed it no longer tracks.
    const liveNodes =
      existing?.customizedAt ? (existing.graphJson as BuiltinGraph).nodes : seed.nodes;
    await foldLegacyReviewerPoolForFlow(db, projectId, flowId, liveNodes);
  }

  // Kanban "Start" dispatches the project's default implement flow; if that
  // was the retired unified flow, point it at `issue-implement` (which now
  // exists — the loop above inserted it if needed).
  // Also covers a legacy row an operator disabled by hand before the split:
  // the kanban default must never point at a disabled flow.
  const legacyRow = await db.query.flows.findFirst({
    where: and(eq(flows.projectId, projectId), eq(flows.slug, LEGACY_LIFECYCLE_SLUG)),
    columns: { id: true },
  });
  const defaultPointsAtLegacy =
    !!project?.defaultImplementFlowId &&
    (project.defaultImplementFlowId === retiredLegacyFlowId ||
      project.defaultImplementFlowId === legacyRow?.id);
  if (defaultPointsAtLegacy) {
    const implement = await db.query.flows.findFirst({
      where: and(eq(flows.projectId, projectId), eq(flows.slug, "issue-implement")),
      columns: { id: true },
    });
    if (implement) {
      await db
        .update(projects)
        .set({ defaultImplementFlowId: implement.id })
        .where(eq(projects.id, projectId));
    }
  }
}

const LEGACY_LIFECYCLE_SLUG = developmentLifecycleFlow.slug;

/**
 * Split the owner's `development-lifecycle` template draft + node settings
 * into the four stage templates. Each stage template reuses the unified
 * graph's node ids, so a draft is carved out by node membership (edges among
 * those nodes) and settings copy 1:1 by node id. Only fills gaps: an existing
 * draft / settings row on a stage template wins. Idempotent.
 */
export async function splitLegacyLifecycleTemplates(db: Db, ownerUserId: string): Promise<void> {
  const legacyDraft = await db.query.templateDrafts.findFirst({
    where: and(
      eq(templateDrafts.userId, ownerUserId),
      eq(templateDrafts.templateSlug, LEGACY_LIFECYCLE_SLUG),
    ),
  });
  const legacySettings = await db
    .select()
    .from(templateNodeSettings)
    .where(
      and(
        eq(templateNodeSettings.userId, ownerUserId),
        eq(templateNodeSettings.templateSlug, LEGACY_LIFECYCLE_SLUG),
      ),
    );
  if (!legacyDraft && legacySettings.length === 0) return;

  for (const def of Object.values(builtinFlows)) {
    const stageNodeIds = new Set(def.nodes.map((n) => n.id));

    if (legacyDraft) {
      const existing = await db.query.templateDrafts.findFirst({
        where: and(eq(templateDrafts.userId, ownerUserId), eq(templateDrafts.templateSlug, def.slug)),
        columns: { id: true, graphJson: true },
      });
      // A stage draft that pre-dates the unified flow (old node ids such as
      // `a1` / `reviewer_correctness`) is stale: the unified draft is the
      // newer intent, so it gets replaced. A stage draft that already uses
      // the current node ids was made after the split and wins.
      const existingIds = new Set(
        ((existing?.graphJson as BuiltinGraph | undefined)?.nodes ?? []).map((n) => n.id),
      );
      const existingIsCurrent =
        !!existing &&
        existingIds.size === stageNodeIds.size &&
        [...stageNodeIds].every((id) => existingIds.has(id));
      const g = legacyDraft.graphJson as BuiltinGraph;
      const nodes = (g.nodes ?? []).filter((n) => stageNodeIds.has(n.id));
      // Carve only when the legacy draft still has this whole stage; a draft
      // that pre-dates the pooled reviewer (three sibling reviewers) falls
      // back to the code template for that stage.
      if (!existingIsCurrent && nodes.length === stageNodeIds.size) {
        const edges = (g.edges ?? []).filter(
          (e) => stageNodeIds.has(e.source) && stageNodeIds.has(e.target),
        );
        const graphJson = { nodes, edges, description: def.description };
        if (existing) {
          await db
            .update(templateDrafts)
            .set({ graphJson, customizedAt: legacyDraft.customizedAt, updatedAt: new Date() })
            .where(eq(templateDrafts.id, existing.id));
        } else {
          await db.insert(templateDrafts).values({
            id: ulid(),
            userId: ownerUserId,
            templateSlug: def.slug,
            graphJson,
            customizedAt: legacyDraft.customizedAt,
            updatedAt: new Date(),
          });
        }
      } else if (existing && !existingIsCurrent) {
        // Stale stage draft but nothing to carve (legacy draft lacks the
        // stage): drop it so the code template applies.
        await db.delete(templateDrafts).where(eq(templateDrafts.id, existing.id));
      }
    }

    // Stage-template rows that reference node ids the stage no longer has
    // (`a1`, `reviewer_correctness`, …) date from before the unified flow and
    // can never apply again; drop them so the template page and the pool
    // fold see only live rows.
    const stale = await db
      .select({ id: templateNodeSettings.id, nodeId: templateNodeSettings.nodeId })
      .from(templateNodeSettings)
      .where(
        and(
          eq(templateNodeSettings.userId, ownerUserId),
          eq(templateNodeSettings.templateSlug, def.slug),
        ),
      );
    const staleIds = stale.filter((r) => !stageNodeIds.has(r.nodeId)).map((r) => r.id);
    if (staleIds.length > 0) {
      await db.delete(templateNodeSettings).where(inArray(templateNodeSettings.id, staleIds));
    }

    for (const row of legacySettings) {
      if (!stageNodeIds.has(row.nodeId)) continue;
      const exists = await db.query.templateNodeSettings.findFirst({
        where: and(
          eq(templateNodeSettings.userId, ownerUserId),
          eq(templateNodeSettings.templateSlug, def.slug),
          eq(templateNodeSettings.nodeId, row.nodeId),
        ),
        columns: { id: true },
      });
      if (exists) continue;
      await db.insert(templateNodeSettings).values({
        id: ulid(),
        userId: ownerUserId,
        templateSlug: def.slug,
        nodeId: row.nodeId,
        promptId: row.promptId,
        agentId: row.agentId,
        fallbackAgentIds: row.fallbackAgentIds,
        retrySame: row.retrySame,
        concurrency: row.concurrency,
        preferred: row.preferred,
        quorum: row.quorum,
        label: row.label,
      });
    }
  }
}

/**
 * Retire a project's `development-lifecycle` row once the split ships, in ONE
 * transaction: disable it (run history stays), put the four stage rows back to
 * enabled + inheriting so the seeding loop refreshes their graph, and carry
 * the legacy row's per-project node overrides (`flow_node_settings`) onto the
 * stage flow whose graph has that node id. Re-entrant: it also repairs the
 * half-done shape (legacy already disabled but every stage row still
 * disabled) that an earlier crash or the old convergence step left behind.
 * Returns the legacy flow id when something was retired/repaired, else null.
 */
async function retireLegacyLifecycleFlow(db: Db, projectId: string): Promise<string | null> {
  const legacy = await db.query.flows.findFirst({
    where: and(eq(flows.projectId, projectId), eq(flows.slug, LEGACY_LIFECYCLE_SLUG)),
    columns: { id: true, enabled: true },
  });
  if (!legacy) return null;
  const stageSlugs = Object.keys(builtinFlows);
  const stageRows = await db
    .select({ id: flows.id, slug: flows.slug, enabled: flows.enabled, graphJson: flows.graphJson })
    .from(flows)
    .where(and(eq(flows.projectId, projectId), inArray(flows.slug, stageSlugs)));
  const stagesAllOff = stageRows.length > 0 && stageRows.every((r) => !r.enabled);
  if (!legacy.enabled && !stagesAllOff) return null;

  await db.transaction(async (tx) => {
    await tx
      .update(flows)
      .set({ enabled: false, updatedAt: new Date() })
      .where(eq(flows.id, legacy.id));
    await tx
      .update(flows)
      .set({ enabled: true, customizedAt: null, updatedAt: new Date() })
      .where(and(eq(flows.projectId, projectId), inArray(flows.slug, stageSlugs)));

    // Per-project overrides made on the unified flow move to the stage flow
    // that owns the node id (never overwriting an override already there).
    const overrides = await tx
      .select()
      .from(flowNodeSettings)
      .where(eq(flowNodeSettings.flowId, legacy.id));
    for (const o of overrides) {
      const def = Object.values(builtinFlows).find((d) => d.nodes.some((n) => n.id === o.nodeId));
      if (!def) continue;
      const target = stageRows.find((r) => r.slug === def.slug);
      if (!target) continue;
      const exists = await tx.query.flowNodeSettings.findFirst({
        where: and(eq(flowNodeSettings.flowId, target.id), eq(flowNodeSettings.nodeId, o.nodeId)),
        columns: { id: true },
      });
      if (exists) continue;
      await tx.insert(flowNodeSettings).values({
        id: ulid(),
        projectId,
        flowId: target.id,
        nodeId: o.nodeId,
        promptId: o.promptId,
        agentId: o.agentId,
        fallbackAgentIds: o.fallbackAgentIds,
        retrySame: o.retrySame,
        concurrency: o.concurrency,
        preferred: o.preferred,
        quorum: o.quorum,
        label: o.label,
      });
    }
  });
  console.log("[flows] retired legacy development-lifecycle flow", { projectId, flowId: legacy.id });
  return legacy.id;
}

/**
 * When a project flow's graph carries the pool `reviewer` node but has no
 * settings row for it yet, fold the legacy sibling-reviewer rows
 * (`reviewer_correctness` / `reviewer_<rand>` …) into one pool row — see
 * legacyReviewerPool.ts. Idempotent; the legacy rows are left in place (they
 * are inert once their nodes are gone). Returns true when a row was written.
 */
export async function foldLegacyReviewerPoolForFlow(
  db: Db,
  projectId: string,
  flowId: string,
  nodes: ReadonlyArray<{ id: string; kind: string }>,
): Promise<boolean> {
  if (!graphHasPoolReviewer(nodes)) return false;
  // Inheritance-aware: an EFFECTIVE reviewer setting (project override OR the
  // account template's row) means the pool is already configured — folding
  // would only turn an inheriting project into an override.
  const effective = await loadEffectiveNodeSetting(db, flowId, POOL_REVIEWER_NODE_ID);
  if (effective) return false;
  const rows = await db.select().from(flowNodeSettings).where(eq(flowNodeSettings.flowId, flowId));
  const folded = foldLegacyReviewerSettings(rows);
  if (!folded) return false;
  await db.insert(flowNodeSettings).values({
    id: ulid(),
    projectId,
    flowId,
    nodeId: POOL_REVIEWER_NODE_ID,
    promptId: folded.promptId,
    agentId: folded.agentId,
    fallbackAgentIds: folded.fallbackAgentIds,
    retrySame: 0,
    concurrency: folded.concurrency,
    preferred: folded.preferred,
    quorum: folded.quorum,
  });
  return true;
}

/** Template-side twin of {@link foldLegacyReviewerPoolForFlow}. */
export async function foldLegacyReviewerPoolForTemplate(
  db: Db,
  userId: string,
  templateSlug: string,
  nodes: ReadonlyArray<{ id: string; kind: string }>,
): Promise<boolean> {
  if (!graphHasPoolReviewer(nodes)) return false;
  const rows = await db
    .select()
    .from(templateNodeSettings)
    .where(
      and(
        eq(templateNodeSettings.userId, userId),
        eq(templateNodeSettings.templateSlug, templateSlug),
      ),
    );
  if (rows.some((r) => r.nodeId === POOL_REVIEWER_NODE_ID)) return false;
  const folded = foldLegacyReviewerSettings(rows);
  if (!folded) return false;
  await db.insert(templateNodeSettings).values({
    id: ulid(),
    userId,
    templateSlug,
    nodeId: POOL_REVIEWER_NODE_ID,
    promptId: folded.promptId,
    agentId: folded.agentId,
    fallbackAgentIds: folded.fallbackAgentIds,
    retrySame: 0,
    concurrency: folded.concurrency,
    preferred: folded.preferred,
    quorum: folded.quorum,
  });
  return true;
}

async function resolveSeedGraph(
  db: Db,
  def: FlowDefinition,
  ownerUserId: string | null,
): Promise<BuiltinGraph> {
  if (ownerUserId) {
    const draft = await db.query.templateDrafts.findFirst({
      where: and(
        eq(templateDrafts.userId, ownerUserId),
        eq(templateDrafts.templateSlug, def.slug),
      ),
    });
    if (draft) {
      const g = draft.graphJson as BuiltinGraph;
      return {
        nodes: g.nodes ?? def.nodes,
        edges: g.edges ?? def.edges,
        description: g.description ?? def.description,
      };
    }
  }
  return { nodes: def.nodes, edges: def.edges, description: def.description };
}

/**
 * Push a saved account-scope template graph to every project flow of that
 * slug (owned by the user) that still inherits it — i.e. has no
 * `customizedAt`. Customized flows keep their own graph until reset. Graph
 * sync is NOT a settings migration: it never touches flow_node_settings (a
 * fold here would resurrect a project override from leftover reviewer_*
 * rows on a project that inherits its reviewer pool).
 */
export async function syncInheritedFlowGraphs(
  db: Db,
  ownerUserId: string,
  slug: string,
  graph: { nodes: ReadonlyArray<{ id: string; kind: string }>; edges: unknown; description?: string },
): Promise<number> {
  const owned = await db
    .select({ id: flows.id })
    .from(flows)
    .innerJoin(projects, eq(projects.id, flows.projectId))
    .where(
      and(eq(projects.addedByUserId, ownerUserId), eq(flows.slug, slug), isNull(flows.customizedAt)),
    );
  for (const f of owned) {
    await db
      .update(flows)
      .set({ graphJson: graph, updatedAt: new Date() })
      .where(eq(flows.id, f.id));
  }
  return owned.length;
}

export async function seedBuiltinFlowsForAllProjects(db: Db): Promise<void> {
  const allProjects = await db.select({ id: projects.id }).from(projects);
  for (const p of allProjects) {
    await ensureBuiltinFlowsForProject(db, p.id);
  }
}

/**
 * Reset a single project flow back to its global template — the same graph a
 * fresh project would be seeded with (the owner's template draft if any, else
 * the code-defined built-in). Discards the project's per-flow graph edits and
 * clears `customizedAt`, so the flow tracks future template/code changes again.
 * Per-node settings (agent/prompt links in `flow_node_settings`) are left
 * untouched, except that legacy sibling-reviewer links are folded into the
 * pool `reviewer` node's row when the template now has one. Returns `{ ok:false }` when the flow has no global template
 * (e.g. a legacy/custom flow not in `builtinFlows`).
 */
export async function resetProjectFlowToTemplate(
  db: Db,
  projectId: string,
  slug: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const def = builtinFlows[slug];
  if (!def) return { ok: false, error: "this flow has no global template" };
  const flow = await db.query.flows.findFirst({
    where: and(eq(flows.projectId, projectId), eq(flows.slug, slug)),
  });
  if (!flow) return { ok: false, error: "flow not found in project" };
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { addedByUserId: true },
  });
  const seed = await resolveSeedGraph(db, def, project?.addedByUserId ?? null);
  await db
    .update(flows)
    .set({
      name: def.name,
      graphJson: seed,
      customizedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(flows.id, flow.id));
  await foldLegacyReviewerPoolForFlow(db, projectId, flow.id, seed.nodes);
  return { ok: true };
}
