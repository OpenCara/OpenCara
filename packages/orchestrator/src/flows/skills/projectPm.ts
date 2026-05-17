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
 * Exposes two opencara-call kinds:
 *   - kanban.wave.dispatch    — dispatch N issues to a flow
 *   - issue.subissue.create   — create a real GitHub sub-issue under a parent
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

## Available opencara-call kinds

### 1. Dispatch issues to a flow

\`\`\`
kind: kanban.wave.dispatch
flowSlug: string          (one of: ${flowSlugs || "— no flows configured yet —"})
issueNumbers: number[]    (max 10 per wave)
\`\`\`

Triggers the named flow for each listed issue in parallel. Before emitting this call, **restate the issues you'll dispatch and to which flow, then wait for the user's confirmation turn**. Only emit the call after the user explicitly confirms.

### 2. Create a GitHub sub-issue

\`\`\`
kind: issue.subissue.create
parentIssueNumber: number
title: string
bodyMd: string
labels?: string[]
\`\`\`

Creates a real GitHub issue and links it as a child of the parent issue via the GitHub tracked-by API. The new issue will appear on the board after a kanban refresh.

## Operational guidance

- **Before dispatching**, confirm: restate which issues go to which flow and wait for user acknowledgment.
- **Before creating sub-issues**, describe the breakdown plan and wait for confirmation.
- Only dispatch to enabled flows. The enabled flows are: ${flowSlugs || "(none — all flows are disabled)"}.
- Maximum 10 issues per wave call.
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
