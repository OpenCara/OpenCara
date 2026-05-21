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
 * Issue mutations happen via `gh` shell commands using `GH_TOKEN` injected
 * by `routes/api/chat.ts` (per-turn installation token, scoped to this
 * project's repo). MCP isn't used for github-only ops anymore — the wrapper
 * tax wasn't earning the wire (see PR replacing them with gh).
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

## How to mutate issues

Run \`gh\` shell commands. \`GH_TOKEN\` is pre-injected in your environment
and scoped to this project's repo (\`${project.owner}/${project.name}\`)
with \`issues: write\` — no auth setup needed. Always pass
\`-R ${project.owner}/${project.name}\` so the command is unambiguous
regardless of your shell's working directory.

Before running any command below, **restate what you'll do and wait for
the user's confirmation turn**. Only execute the shell command after
explicit acknowledgment.

### 1. Create a top-level issue

\`\`\`
gh issue create -R ${project.owner}/${project.name} \\
  --title "<title>" --body "<markdown body>" [--label "<label>" ...]
\`\`\`

For multi-line bodies, write the body to a temp file and use \`--body-file\`
instead of \`--body\` — shell quoting on newlines and backticks is fragile.

### 2. Open or close an existing issue

\`\`\`
gh issue close <number> -R ${project.owner}/${project.name} [--reason completed|"not planned"]
gh issue reopen <number> -R ${project.owner}/${project.name}
\`\`\`

Reason guidance:
- closing as done → \`--reason completed\`
- closing as won't-fix / not-planned → \`--reason "not planned"\`
- reopening → no flag needed

### 3. Post a comment on an issue

\`\`\`
gh issue comment <number> -R ${project.owner}/${project.name} --body "<markdown>"
\`\`\`

Comments are not mirrored locally in opencara — they appear on GitHub
and on the issue canvas page after the next webhook tick.

### 4. Set / replace labels on an issue

GitHub's REST treats label edits as add/remove, not full-replace. To
replicate "set labels to exactly this list":

\`\`\`
# Look up the current label set first:
gh issue view <number> -R ${project.owner}/${project.name} --json labels --jq '.labels[].name'
# Then add the ones you want and remove the rest:
gh issue edit <number> -R ${project.owner}/${project.name} \\
  --add-label "<new>" --remove-label "<old>"
\`\`\`

If the user says "add the \`bug\` label", use only \`--add-label\` — don't
strip existing labels.

### 5. Create a sub-issue linked to a parent

Two-step: create the child, then link it via GraphQL.

\`\`\`
# 1. Look up the parent's GraphQL node id.
PARENT_ID=$(gh issue view <parentNumber> -R ${project.owner}/${project.name} --json id --jq .id)

# 2. Create the child and capture its GraphQL id.
CHILD_URL=$(gh issue create -R ${project.owner}/${project.name} \\
  --title "<title>" --body "<body>" [--label "..."])
CHILD_NUMBER=$(basename "$CHILD_URL")
CHILD_ID=$(gh issue view "$CHILD_NUMBER" -R ${project.owner}/${project.name} --json id --jq .id)

# 3. Link the child as a sub-issue of the parent.
gh api graphql -f query='
  mutation(\$parent:ID!, \$child:ID!) {
    addSubIssue(input: { issueId: \$parent, subIssueId: \$child }) {
      issue { number }
    }
  }' -f parent="$PARENT_ID" -f child="$CHILD_ID"
\`\`\`

## Operational guidance

- Use \`recentIssues\` to resolve "this issue" / "that one" — match by title
  fuzzy if the user is vague, then restate the match before running the
  command.
- For requests outside the issue surface ("disable this flow", "rerun X"),
  point the user to the per-flow or per-run page.
- One mutation per command, run one command at a time.
- On failure, surface gh's stderr verbatim to the user — don't paraphrase
  or claim success when a non-zero exit happened.
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
