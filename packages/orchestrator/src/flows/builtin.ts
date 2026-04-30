import { ulid } from "ulid";
import { eq, and } from "drizzle-orm";
import { builtinFlows, type FlowDefinition } from "@opencara/flows";
import type { Db } from "../db/client.js";
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
  }
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
