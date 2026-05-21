import { and, eq, isNull } from "drizzle-orm";
import {
  flows,
  pmWaveItems,
  pmWaves,
  projectV2Items,
  projectV2Links,
  projects,
} from "../../db/schema.js";
import type { PageSkillBuilder } from "../skills.js";

/**
 * PM agent skill for the kanban tab (/projects/:id/kanban).
 *
 * Hydrates:
 *   - project     — owner / name / defaultBranch
 *   - board       — columns with items from the linked Projects v2 board
 *   - flows       — slug / name / enabled for each project flow
 *   - activeWaves — pm_waves rows with status=running and their items
 *
 * Mutation surface:
 *   - issue create / sub-issue create → `gh` shell commands using GH_TOKEN
 *     injected by routes/api/chat.ts (per-turn installation token)
 *   - opencara_kanban_wave_dispatch    — MCP tool (genuine opencara, dispatches
 *     a wave into the flow engine)
 */
export const projectPmBuilder: PageSkillBuilder = async (ctx) => {
  const projectId = ctx.pageContext.projectId;
  if (!projectId) return null;

  const project = await ctx.db.query.projects.findFirst({
    where: and(
      eq(projects.id, projectId),
      eq(projects.addedByUserId, ctx.user.id),
      isNull(projects.removedAt),
    ),
  });
  if (!project) return null;

  const [flowsList, link] = await Promise.all([
    ctx.db.query.flows.findMany({ where: eq(flows.projectId, projectId) }),
    ctx.db.query.projectV2Links.findFirst({
      where: eq(projectV2Links.projectId, projectId),
    }),
  ]);

  // Build board columns from the linked Projects v2 mirror.
  let board: {
    columns: Array<{ name: string; items: Array<{ issueNumber: number | null; title: string; labels: Array<{ name: string; color: string }> }> }>;
  } = { columns: [] };

  if (link) {
    const items = await ctx.db.query.projectV2Items.findMany({
      where: and(
        eq(projectV2Items.projectV2LinkId, link.id),
        eq(projectV2Items.isArchived, false),
      ),
    });

    const columns = new Map<string | null, typeof items>();
    for (const item of items) {
      const key = item.statusOptionId;
      const list = columns.get(key) ?? [];
      list.push(item);
      columns.set(key, list);
    }

    const orderedOptions = [...link.statusOptions].sort(
      (a, b) => a.position - b.position,
    );

    board = {
      columns: [
        ...orderedOptions.map((opt) => ({
          name: opt.name,
          items: (columns.get(opt.optionId) ?? []).map((it) => ({
            issueNumber: it.contentNumber,
            title: it.contentTitle,
            labels: it.labels,
          })),
        })),
        {
          name: "No status",
          items: (columns.get(null) ?? []).map((it) => ({
            issueNumber: it.contentNumber,
            title: it.contentTitle,
            labels: it.labels,
          })),
        },
      ].filter((col) => col.items.length > 0 || orderedOptions.some((o) => o.name === col.name)),
    };
  }

  // Load active waves with their items.
  const runningWaves = await ctx.db.query.pmWaves.findMany({
    where: and(eq(pmWaves.projectId, projectId), eq(pmWaves.status, "running")),
  });

  const activeWaves = await Promise.all(
    runningWaves.map(async (wave) => {
      const waveItems = await ctx.db.query.pmWaveItems.findMany({
        where: eq(pmWaveItems.waveId, wave.id),
      });
      return { ...wave, items: waveItems };
    }),
  );

  const baseUrl = ctx.baseUrl.replace(/\/$/, "");
  const flowSlugs = flowsList
    .filter((f) => f.enabled)
    .map((f) => f.slug)
    .join(", ");

  const instructions = `# Skill: opencara-project-pm

You are the **PM agent** for the project \`${project.owner}/${project.name}\`, operating from the kanban board view. Your role is to help the user triage issues, break large issues into sub-tasks, and dispatch batches of work to the project's automation flows.

## Hydrated stdin keys

- \`project\`     — project metadata (owner, name, defaultBranch)
- \`board\`       — the current kanban board: columns with issue numbers, titles, and labels
- \`flows\`       — all project flows (slug, name, enabled)
- \`activeWaves\` — currently running dispatch waves with their items

## How to mutate

Issue creation runs through \`gh\` shell commands. \`GH_TOKEN\` is pre-injected
in your environment, scoped to \`${project.owner}/${project.name}\` with
\`issues: write\` — no auth setup needed. Always pass
\`-R ${project.owner}/${project.name}\` so the command is unambiguous.

Wave dispatch is the one operation that stays as an MCP tool — it triggers
opencara's flow engine, not a GitHub call.

Before running anything below, **restate what you'll do and wait for the
user's confirmation turn**. Only act after explicit acknowledgment.

### 1. Create a top-level issue

\`\`\`
gh issue create -R ${project.owner}/${project.name} \\
  --title "<title>" --body "<markdown>" [--label "<label>" ...]
\`\`\`

Use \`--body-file\` instead of \`--body\` for multi-line bodies — shell
quoting on newlines / backticks is fragile.

The new issue lands on the kanban after the GitHub webhook reconciles
(usually ~1–5s; the board polls for refresh).

### 2. Create a GitHub sub-issue under a parent

Two-step: create the child, then link via GraphQL.

\`\`\`
PARENT_ID=$(gh issue view <parentNumber> -R ${project.owner}/${project.name} --json id --jq .id)

CHILD_URL=$(gh issue create -R ${project.owner}/${project.name} \\
  --title "<title>" --body "<body>" [--label "..."])
CHILD_NUMBER=$(basename "$CHILD_URL")
CHILD_ID=$(gh issue view "$CHILD_NUMBER" -R ${project.owner}/${project.name} --json id --jq .id)

gh api graphql -f query='
  mutation(\$parent:ID!, \$child:ID!) {
    addSubIssue(input: { issueId: \$parent, subIssueId: \$child }) {
      issue { number }
    }
  }' -f parent="$PARENT_ID" -f child="$CHILD_ID"
\`\`\`

### 3. \`opencara_kanban_wave_dispatch\` — dispatch issues to a flow (MCP tool)

This stays as an MCP tool because it triggers opencara's flow engine,
not a GitHub mutation. Call it through your tool-calling interface.

Args:
- \`flowSlug\` (string, required — one of: ${flowSlugs || "— no flows configured yet —"})
- \`issueNumbers\` (number[], required — 1 to 10 per wave)

Triggers the named flow for each listed issue in parallel. Before calling
this tool, **restate the issues you'll dispatch and to which flow, then
wait for the user's confirmation turn**. Only call the tool after the
user explicitly confirms.

## Operational guidance

- **Before dispatching**, confirm: restate which issues go to which flow and wait for user acknowledgment.
- **Before creating issues or sub-issues**, restate the title, body, and labels you'll create and wait for confirmation.
- Only dispatch to enabled flows. The enabled flows are: ${flowSlugs || "(none — all flows are disabled)"}.
- Maximum 10 issues per wave call.
- The MCP tool returns \`"ok"\` on success or \`"rejected: <reason>"\` on failure — surface failures back to the user verbatim instead of claiming the dispatch succeeded.
- For \`gh\` commands: on non-zero exit, surface gh's stderr verbatim — don't paraphrase or claim success.
- If the user asks about something outside the board (e.g. "what's in the PR queue"), explain you only have kanban context and suggest navigating to the relevant page.
`;

  return {
    skill: {
      name: "opencara-project-pm",
      instructions,
      baseUrl,
      runId: ctx.runId,
    },
    hydrated: {
      project: {
        id: project.id,
        owner: project.owner,
        name: project.name,
        defaultBranch: project.defaultBranch,
      },
      board,
      flows: flowsList.map((f) => ({
        slug: f.slug,
        name: f.name,
        enabled: f.enabled,
      })),
      activeWaves,
    },
    projectScope: projectId,
  };
};
