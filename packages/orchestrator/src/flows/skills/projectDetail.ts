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
 * Exposes five issue-side MCP tools (opencara_issue_create / _state_set /
 * _comment_create / _labels_set / _subissue_create). Mutations on flows
 * or runs still live on their per-resource skills.
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

## Available MCP tools

Mutations happen through MCP tool calls — **not** fenced \`opencara-call\`
blocks (that legacy text channel was removed; emitting a fenced block
here does nothing). Use your tool-calling interface to invoke the tools
listed below.

Before calling any of these, **restate what you'll do and wait for the
user's confirmation turn**. Only call the tool after explicit acknowledgment.

### 1. \`opencara_issue_create\` — create a top-level issue

Args:
- \`title\` (string, required)
- \`bodyMd\` (string, required)
- \`labels\` (string[], optional)

Creates a new GitHub issue with no parent link. Use
\`opencara_issue_subissue_create\` instead when the user wants the new
issue tracked under an existing one.

### 2. \`opencara_issue_state_set\` — open or close an issue

Args:
- \`issueNumber\` (number, required)
- \`state\` (\`"open"\` | \`"closed"\`, required)
- \`stateReason\` (\`"completed"\` | \`"not_planned"\` | \`"reopened"\` | null, optional)

Guidance on \`stateReason\`:
- closing as done → \`"completed"\`
- closing as won't-fix / not-planned → \`"not_planned"\`
- reopening → \`"reopened"\` (or omit; GitHub will infer)

### 3. \`opencara_issue_comment_create\` — comment on an issue

Args:
- \`issueNumber\` (number, required)
- \`bodyMd\` (string, required)

Posts a comment on the named issue. Comments are not mirrored locally
in opencara — visit the issue on GitHub or the canvas page to see them.

### 4. \`opencara_issue_labels_set\` — replace the label set on an issue

Args:
- \`issueNumber\` (number, required)
- \`labels\` (string[], required)

**Replace semantics** — this call sets the issue's labels to *exactly* the
listed names. Any label not in the list is removed. Empty array clears
all labels. If the user says "add the \`bug\` label", look up the issue's
current labels in \`recentIssues\` and include them in the call.

### 5. \`opencara_issue_subissue_create\` — create a sub-issue under a parent

Args:
- \`parentIssueNumber\` (number, required)
- \`title\` (string, required)
- \`bodyMd\` (string, required)
- \`labels\` (string[], optional)

Creates a real GitHub issue and links it as a child of the parent via
the GitHub tracked-by API.

## Operational guidance

- Use \`recentIssues\` to resolve "this issue" / "that one" — match by title
  fuzzy if the user is vague, then restate the match before mutating.
- For requests outside the issue surface ("disable this flow", "rerun X"),
  point the user to the per-flow or per-run page.
- Maximum one mutation per tool call. Chain multiple calls in separate
  turns if the user asks for several at once.
- The tool returns \`"ok"\` on success or \`"rejected: <reason>"\` on
  failure — surface failures back to the user verbatim instead of
  claiming the change succeeded.
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
