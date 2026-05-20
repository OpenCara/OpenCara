import { and, desc, eq, isNull } from "drizzle-orm";
import {
  flowRuns,
  flows,
  issues,
  platformEvents,
  projects,
} from "../../db/schema.js";
import type { PageSkillBuilder } from "../skills.js";

const RECENT_LIMIT = 25;

/**
 * Project overview page (apps/web/src/pages/ProjectDetailPage.tsx) and
 * its tab variants (`/issues`, `/events`, `/flow-runs`, `/runs`) — all
 * routed to the same `project-detail` skill by ChatPanel.
 *
 * Exposes five issue-side opencara-call kinds (issue.create / state.set /
 * comment.create / labels.set / subissue.create). Mutations on flows or
 * runs still live on their per-resource skills.
 */
export const projectDetailBuilder: PageSkillBuilder = async (ctx) => {
  const projectId = ctx.pageContext.projectId;
  if (!projectId) return null;

  const project = await ctx.db.query.projects.findFirst({
    where: and(eq(projects.id, projectId), isNull(projects.removedAt)),
  });
  if (!project) return null;

  const [flowsList, recentRuns, recentEvents, recentIssues] = await Promise.all([
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
    ctx.db.query.issues.findMany({
      where: and(eq(issues.projectId, projectId), isNull(issues.removedAt)),
      orderBy: [desc(issues.updatedAt)],
      limit: RECENT_LIMIT,
      columns: {
        number: true,
        title: true,
        state: true,
        stateReason: true,
        labels: true,
        htmlUrl: true,
      },
    }),
  ]);

  const baseUrl = ctx.baseUrl.replace(/\/$/, "");
  const instructions = `# Skill: opencara-project-overview

You are looking at the project \`${project.owner}/${project.name}\` in opencara.
The project's tabs (Overview / Issues / Events / Flow runs / Runs) are all
informational; mutations on flows or per-run state still live on their own
pages. From this skill you can manage the project's GitHub **issues**.

## Hydrated stdin keys

- \`project\` — the project row (id, owner, name, default_branch, etc.).
- \`flows\` — the project's configured flows (id, slug, name, enabled).
- \`recentRuns\` — last ${RECENT_LIMIT} flow runs (newest first).
- \`recentEvents\` — last ${RECENT_LIMIT} platform events (id, type, receivedAt).
- \`recentIssues\` — last ${RECENT_LIMIT} issues by updatedAt (number, title, state, stateReason, labels, htmlUrl).

## Available opencara-call kinds

Before emitting any of these, **restate what you'll do and wait for the
user's confirmation turn**. Only emit the call after explicit acknowledgment.

### 1. Create a top-level issue

\`\`\`
kind: issue.create
title: string
bodyMd: string
labels?: string[]
\`\`\`

Creates a new GitHub issue with no parent link. Use \`issue.subissue.create\`
instead when the user wants the new issue tracked under an existing one.

### 2. Open or close an issue

\`\`\`
kind: issue.state.set
issueNumber: number
state: "open" | "closed"
stateReason?: "completed" | "not_planned" | "reopened" | null
\`\`\`

Guidance on \`stateReason\`:
- closing as done → \`"completed"\`
- closing as won't-fix / not-planned → \`"not_planned"\`
- reopening → \`"reopened"\` (or omit; GitHub will infer)

### 3. Comment on an issue

\`\`\`
kind: issue.comment.create
issueNumber: number
bodyMd: string
\`\`\`

Posts a comment on the named issue. Comments are not mirrored locally
in opencara — visit the issue on GitHub or the canvas page to see them.

### 4. Replace the label set on an issue

\`\`\`
kind: issue.labels.set
issueNumber: number
labels: string[]
\`\`\`

**Replace semantics** — this call sets the issue's labels to *exactly* the
listed names. Any label not in the list is removed. Empty array clears
all labels. If the user says "add the \`bug\` label", look up the issue's
current labels in \`recentIssues\` and include them in the call.

### 5. Create a sub-issue under a parent

\`\`\`
kind: issue.subissue.create
parentIssueNumber: number
title: string
bodyMd: string
labels?: string[]
\`\`\`

Creates a real GitHub issue and links it as a child of the parent via
the GitHub tracked-by API.

## Operational guidance

- Use \`recentIssues\` to resolve "this issue" / "that one" — match by title
  fuzzy if the user is vague, then restate the match before mutating.
- For requests outside the issue surface ("disable this flow", "rerun X"),
  point the user to the per-flow or per-run page.
- Maximum one mutation per call. Chain multiple calls in separate turns
  if the user asks for several at once.
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
      recentIssues,
    },
    projectScope: projectId,
  };
};
