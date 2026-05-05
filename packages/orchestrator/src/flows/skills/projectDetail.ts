import { and, desc, eq, isNull } from "drizzle-orm";
import {
  flowRuns,
  flows,
  platformEvents,
  projects,
} from "../../db/schema.js";
import type { PageSkillBuilder } from "../skills.js";

const RECENT_LIMIT = 25;

/**
 * Project overview page (apps/web/src/pages/ProjectDetailPage.tsx). Pure
 * read-only — the page itself only triggers mutations (delete, etc.) by
 * navigating to other pages. The skill exposes no `opencara-call` kinds;
 * its value is hydrated context so the agent can answer "what's going
 * on with this project" without fetching.
 */
export const projectDetailBuilder: PageSkillBuilder = async (ctx) => {
  const projectId = ctx.pageContext.projectId;
  if (!projectId) return null;

  const project = await ctx.db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), isNull(projects.removedAt)),
  });
  if (!project) return null;

  const [flowsList, recentRuns, recentEvents] = await Promise.all([
    ctx.db.query.flows.findMany({ where: eq(flows.projectId, projectId) }),
    ctx.db.query.flowRuns.findMany({
      where: eq(flowRuns.projectId, projectId),
      orderBy: [desc(flowRuns.createdAt)],
      limit: RECENT_LIMIT,
    }),
    ctx.db
      .select({
        id: platformEvents.id,
        type: platformEvents.type,
        receivedAt: platformEvents.receivedAt,
      })
      .from(platformEvents)
      .where(eq(platformEvents.projectId, projectId))
      .orderBy(desc(platformEvents.receivedAt))
      .limit(RECENT_LIMIT),
  ]);

  const baseUrl = ctx.baseUrl.replace(/\/$/, "");
  const instructions = `# Skill: opencara-project-overview

You are looking at a project's overview in opencara — \`${project.owner}/${project.name}\`.
The project's tabs (Overview / Issues / Events / Flow runs / Runs) are all
informational; this skill exposes **no \`opencara-call\` kinds**.

Hydrated stdin keys:

- \`project\` — the project row (id, owner, name, default_branch, etc.).
- \`flows\` — the project's configured flows (id, slug, name, enabled).
- \`recentRuns\` — last ${RECENT_LIMIT} flow runs (newest first).
- \`recentEvents\` — last ${RECENT_LIMIT} platform events (id, type, receivedAt).

If the user asks for a mutation here ("disable this flow", "rerun X"),
explain that mutations live on the per-flow or per-run page, and the
user should navigate there before asking. Don't emit \`opencara-call\`
blocks — they will be ignored.
`;

  return {
    skill: {
      name: "opencara-project-overview",
      instructions,
      baseUrl,
      runId: ctx.runId,
    },
    hydrated: {
      project,
      flows: flowsList,
      recentRuns,
      recentEvents,
    },
    projectScope: projectId,
  };
};
