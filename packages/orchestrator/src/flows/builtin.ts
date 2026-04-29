import { ulid } from "ulid";
import { eq, and } from "drizzle-orm";
import { builtinFlows } from "@opencara/flows";
import type { Db } from "../db/client.js";
import { flows, projects } from "../db/schema.js";

export async function ensureBuiltinFlowsForProject(db: Db, projectId: string): Promise<void> {
  for (const slug of Object.keys(builtinFlows)) {
    const def = builtinFlows[slug]!;
    const existing = await db.query.flows.findFirst({
      where: and(eq(flows.projectId, projectId), eq(flows.slug, slug)),
    });
    if (existing) {
      // Don't clobber a graph the user has edited (rename / add / remove
      // reviewer). The customizedAt sentinel is set by the graph-mutation
      // routes; until then, keep the seed in sync with code.
      if (existing.customizedAt) continue;
      await db
        .update(flows)
        .set({
          name: def.name,
          graphJson: { nodes: def.nodes, edges: def.edges, description: def.description },
          updatedAt: new Date(),
        })
        .where(eq(flows.id, existing.id));
      continue;
    }
    await db.insert(flows).values({
      id: ulid(),
      projectId,
      slug,
      name: def.name,
      graphJson: { nodes: def.nodes, edges: def.edges, description: def.description },
      enabled: true,
    });
  }
}

export async function seedBuiltinFlowsForAllProjects(db: Db): Promise<void> {
  const allProjects = await db.select({ id: projects.id }).from(projects);
  for (const p of allProjects) {
    await ensureBuiltinFlowsForProject(db, p.id);
  }
}
