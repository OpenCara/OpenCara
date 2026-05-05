import { and, desc, eq } from "drizzle-orm";
import { flowNodeSettings, flowRuns, flows } from "../../db/schema.js";
import type { PageSkillBuilder } from "../skills.js";

/**
 * Project flow detail page (apps/web/src/pages/ProjectFlowDetailPage.tsx).
 * The agent can edit a node's config via `flow.node.config.set` — it MUST
 * read the existing config out of the hydrated `flow.graphJson` and merge,
 * because the call replaces the whole config object.
 */
export const projectFlowDetailBuilder: PageSkillBuilder = async (ctx) => {
  const projectId = ctx.pageContext.projectId;
  const slug = ctx.pageContext.flowSlug;
  if (!projectId || !slug) return null;

  const flow = await ctx.db.query.flows.findFirst({
    where: and(eq(flows.projectId, projectId), eq(flows.slug, slug)),
  });
  if (!flow) return null;

  const [recentRuns, nodeSettings] = await Promise.all([
    ctx.db.query.flowRuns.findMany({
      where: eq(flowRuns.flowId, flow.id),
      orderBy: [desc(flowRuns.createdAt)],
      limit: 10,
    }),
    ctx.db
      .select()
      .from(flowNodeSettings)
      .where(eq(flowNodeSettings.flowId, flow.id)),
  ]);

  const baseUrl = ctx.baseUrl.replace(/\/$/, "");
  const instructions = `# Skill: opencara-flow-edit

You can edit a node's config on the flow \`${flow.slug}\` (in project
\`${projectId}\`). The full graph (nodes + edges + each node's current
config) is provided to you on stdin under \`flow.graphJson\`.

## How to call it

\`\`\`opencara-call
{
  "kind": "flow.node.config.set",
  "flowSlug": "${flow.slug}",
  "nodeId": "<one of flow.graphJson.nodes[*].id>",
  "config": { /* full new config object for that node */ }
}
\`\`\`

## Semantics

- **\`config\` REPLACES the node's whole config object.** Read the existing
  value from \`flow.graphJson.nodes[i].config\` and merge — never send a
  partial config that drops fields the user already set.
- The candidate graph is validated against \`FlowDefinitionSchema\` before
  it persists; an invalid config is rejected and the call has no effect.
- \`customizedAt\` is set so the seeder won't clobber your edit on the
  next orchestrator restart.

## Out of scope

Adding/removing nodes, adding reviewers, deleting reviewers, toggling
\`enabled\` — those still go through the UI. Don't emit calls with other
\`kind\` values; they are silently ignored.

## Hydrated stdin keys

- \`flow\` — the flow row (id, slug, name, enabled, graphJson, customizedAt).
- \`nodeSettings\` — per-node label/agent/prompt links currently configured.
- \`recentRuns\` — the last 10 runs of this flow.
`;

  return {
    skill: {
      name: "opencara-flow-edit",
      instructions,
      baseUrl,
      runId: ctx.runId,
    },
    hydrated: { flow, nodeSettings, recentRuns },
    projectScope: projectId,
  };
};
