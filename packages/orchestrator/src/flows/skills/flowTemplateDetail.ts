import { and, eq } from "drizzle-orm";
import { builtinFlows } from "@opencara/flows";
import { templateDrafts, templateNodeSettings } from "../../db/schema.js";
import type { PageSkillBuilder } from "../skills.js";

/**
 * Flow template detail page (apps/web/src/pages/FlowTemplateDetailPage.tsx).
 * Templates are global, but every edit lands in the user's own
 * `template_drafts` row — never on the published code template. The
 * builder hydrates the user's current draft (or the code template if no
 * draft exists yet) and exposes `template.node.config.set` for edits.
 */
export const flowTemplateDetailBuilder: PageSkillBuilder = async (ctx) => {
  const slug = ctx.pageContext.flowSlug;
  if (!slug) return null;
  const def = builtinFlows[slug];
  if (!def) return null;

  const draft = await ctx.db.query.templateDrafts.findFirst({
    where: and(
      eq(templateDrafts.userId, ctx.user.id),
      eq(templateDrafts.templateSlug, slug),
    ),
  });
  const settings = await ctx.db
    .select()
    .from(templateNodeSettings)
    .where(
      and(
        eq(templateNodeSettings.userId, ctx.user.id),
        eq(templateNodeSettings.templateSlug, slug),
      ),
    );

  const graph = draft
    ? draft.graphJson
    : { nodes: def.nodes, edges: def.edges, description: def.description };

  const baseUrl = ctx.baseUrl.replace(/\/$/, "");
  const instructions = `# Skill: opencara-template-edit

You can edit a node's config on the flow template \`${def.slug}\`. The
full graph is provided to you on stdin under \`template.graphJson\`.

## How to call it

\`\`\`opencara-call
{
  "kind": "template.node.config.set",
  "templateSlug": "${def.slug}",
  "nodeId": "<one of template.graphJson.nodes[*].id>",
  "config": { /* full new config object for that node */ }
}
\`\`\`

## Semantics

- **Per-user draft.** Edits land in your draft (\`template_drafts\`),
  never the published code template. The user is editing their own
  copy of this template; future projects they create will pick this
  up via the seeder.
- **\`config\` REPLACES the node's whole config object.** Read the
  existing value from \`template.graphJson.nodes[i].config\` and merge.
- The candidate graph is validated against \`FlowDefinitionSchema\`
  before it persists.

## Out of scope

Adding/removing reviewer nodes, editing per-node agent/prompt links —
those still go through the UI. Don't emit calls with other \`kind\`
values; they are silently ignored.

## Hydrated stdin keys

- \`template\` — \`{ slug, name, description, graphJson }\` reflecting
  the user's draft when one exists, otherwise the code template.
- \`hasDraft\` — boolean. False means this is the user's first edit;
  \`template.node.config.set\` materialises a draft on the spot.
- \`nodeSettings\` — per-node agent/prompt/label links the user has
  set on this template.
`;

  return {
    skill: {
      name: "opencara-template-edit",
      instructions,
      baseUrl,
      runId: ctx.runId,
    },
    hydrated: {
      template: {
        slug: def.slug,
        name: def.name,
        description: def.description,
        graphJson: graph,
      },
      hasDraft: !!draft,
      nodeSettings: settings,
    },
    projectScope: ctx.pageContext.projectId ?? null,
  };
};
