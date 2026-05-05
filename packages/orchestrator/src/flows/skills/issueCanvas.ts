import { and, eq, isNull } from "drizzle-orm";
import { issues, projects } from "../../db/schema.js";
import type { PageSkillBuilder, SkillEnvelope } from "../skills.js";

/**
 * Issue canvas page (apps/web/src/pages/IssueDetailPage.tsx). The chat
 * runs against the user's currently-visible issue body. The agent emits
 * ```opencara-call``` blocks with kind="issue.body.set" to update the
 * draft — published GitHub state is unchanged until the user clicks Save.
 *
 * Auth: the canvas object's projectId comes from the client; the builder
 * verifies it exists and isn't soft-deleted before any data leaves.
 * Mirrors the gate that lived inline in chat.ts before this refactor.
 */
export const issueCanvasBuilder: PageSkillBuilder = async (ctx) => {
  const canvas = ctx.pageContext.canvas;
  if (!canvas || canvas.kind !== "issue") return null;

  const project = await ctx.db.query.projects.findFirst({
    where: and(eq(projects.id, canvas.projectId), isNull(projects.removedAt)),
  });
  if (!project) {
    return {
      skill: buildIssueCanvasEnvelope({
        baseUrl: ctx.baseUrl,
        runId: ctx.runId,
        issueNumber: canvas.issueNumber,
      }),
      hydrated: {},
      authError: "canvas project not accessible",
    };
  }

  // Hand the agent the CURRENTLY VISIBLE body — the unsaved draft if one
  // exists, otherwise the GitHub-mirrored body. If we sent row.bodyMd
  // unconditionally the agent would rewrite a stale base and overwrite
  // the user's in-progress draft on save.
  const row = await ctx.db.query.issues.findFirst({
    where: and(
      eq(issues.projectId, canvas.projectId),
      eq(issues.number, canvas.issueNumber),
      isNull(issues.removedAt),
    ),
  });

  const hydrated: Record<string, unknown> = {};
  if (row) {
    hydrated["issue"] = {
      number: row.number,
      title: row.title,
      bodyMd: row.draftBodyMd ?? row.bodyMd,
      labels: row.labels,
      assignees: row.assignees,
      state: row.state,
      htmlUrl: row.htmlUrl,
    };
  }
  if (canvas.selection) hydrated["selection"] = canvas.selection;

  return {
    skill: buildIssueCanvasEnvelope({
      baseUrl: ctx.baseUrl,
      runId: ctx.runId,
      issueNumber: canvas.issueNumber,
    }),
    hydrated,
    projectScope: canvas.projectId,
  };
};

/**
 * Pure markdown construction shared between the chat path (page skill
 * builder above) and the flow engine (nodeRunners injects this on
 * issue-context runs even without a page). No DB I/O — callers hydrate
 * issue data themselves.
 */
export function buildIssueCanvasEnvelope(opts: {
  baseUrl: string;
  runId: string;
  issueNumber: number;
}): SkillEnvelope {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const instructions = `# Skill: opencara-issue-edit

You can update this issue's body draft directly. The user is looking at
the canvas page; whatever you write here shows up immediately as a draft
(with a diff against the published body) and waits for them to click
"Save to GitHub".

## How to call it

Emit a fenced JSON block on stdout — the CLI runner intercepts it and
proxies the call back on your behalf. There is no HTTP request for you
to make and no token for you to manage.

\`\`\`opencara-call
{
  "kind": "issue.body.set",
  "issueNumber": ${opts.issueNumber},
  "bodyMd": "<full new markdown>"
}
\`\`\`

## Semantics

- **\`bodyMd\` is the WHOLE markdown.** To rewrite a snippet, take the
  current body (provided as \`issue.bodyMd\` on stdin) and substitute
  the targeted section into it. \`issue.bodyMd\` reflects the
  CURRENTLY VISIBLE state — it's the unsaved draft if one exists, or
  the GitHub-mirrored body otherwise. Always rebase your rewrite on
  what the user is actually looking at, not on the published version.
- The published body on GitHub is unchanged until the user clicks
  "Save to GitHub" in the UI.
- The block is also visible in your chat reply (it's just stdout).
  That's fine — the user sees what you asked for.

## Out of scope today

Title, labels, assignees, state, comments. Don't emit calls with other
\`kind\` values; they are silently ignored.
`;
  return {
    name: "opencara-issue-edit",
    instructions,
    baseUrl,
    runId: opts.runId,
  };
}
