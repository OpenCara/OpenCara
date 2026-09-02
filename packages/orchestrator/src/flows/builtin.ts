import { ulid } from "ulid";
import { eq, and } from "drizzle-orm";
import { builtinFlows, type FlowDefinition } from "@opencara/flows";
import type { Db } from "../db/client.js";
import {
  POOL_REVIEWER_NODE_ID,
  foldLegacyReviewerSettings,
  graphHasPoolReviewer,
} from "./legacyReviewerPool.js";
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
 * page. The same is true for `template_node_settings`: rows there are copied
 * into `flow_node_settings` (only when a project flow row is freshly inserted,
 * never overwriting existing per-project edits).
 */
export async function ensureBuiltinFlowsForProject(db: Db, projectId: string): Promise<void> {
  const project = await db.query.projects.findFirst({
    where: eq(projects.id, projectId),
    columns: { id: true, addedByUserId: true },
  });
  const ownerUserId = project?.addedByUserId ?? null;

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

    if (didInsert && ownerUserId) {
      await seedNodeSettingsFromTemplate(db, projectId, flowId, slug, ownerUserId, seed);
    }
    // A customized flow keeps its own graph, so judge the fold on what the
    // flow actually runs, not on the seed it no longer tracks.
    const liveNodes =
      existing?.customizedAt ? (existing.graphJson as BuiltinGraph).nodes : seed.nodes;
    await foldLegacyReviewerPoolForFlow(db, projectId, flowId, liveNodes);
  }
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
  const rows = await db.select().from(flowNodeSettings).where(eq(flowNodeSettings.flowId, flowId));
  if (rows.some((r) => r.nodeId === POOL_REVIEWER_NODE_ID)) return false;
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

async function seedNodeSettingsFromTemplate(
  db: Db,
  projectId: string,
  flowId: string,
  slug: string,
  ownerUserId: string,
  seed: BuiltinGraph,
): Promise<void> {
  const settings = await db
    .select()
    .from(templateNodeSettings)
    .where(
      and(
        eq(templateNodeSettings.userId, ownerUserId),
        eq(templateNodeSettings.templateSlug, slug),
      ),
    );
  if (settings.length === 0) return;
  const knownNodeIds = new Set(seed.nodes.map((n) => n.id));
  for (const s of settings) {
    if (!knownNodeIds.has(s.nodeId)) continue;
    const exists = await db.query.flowNodeSettings.findFirst({
      where: and(
        eq(flowNodeSettings.flowId, flowId),
        eq(flowNodeSettings.nodeId, s.nodeId),
      ),
      columns: { id: true },
    });
    if (exists) continue;
    await db.insert(flowNodeSettings).values({
      id: ulid(),
      projectId,
      flowId,
      nodeId: s.nodeId,
      promptId: s.promptId,
      agentId: s.agentId,
      fallbackAgentIds: s.fallbackAgentIds,
      retrySame: s.retrySame,
      concurrency: s.concurrency,
      quorum: s.quorum,
      label: s.label,
    });
  }
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
