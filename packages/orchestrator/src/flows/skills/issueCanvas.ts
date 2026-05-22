import { and, eq, isNull } from "drizzle-orm";
import { issues, projects } from "../../db/schema.js";
import type { PageSkillBuilder, SkillEnvelope } from "../skills.js";

/**
 * Issue canvas page (apps/web/src/pages/IssueDetailPage.tsx). The chat
 * runs against the user's currently-visible issue body. The agent calls
 * the `opencara_issue_body_set` MCP tool to update the draft — published
 * GitHub state is unchanged until the user clicks Save.
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

Call the \`opencara_issue_body_set\` MCP tool with these args:

- \`issueNumber\` (number, required) — pass \`${opts.issueNumber}\`
- \`bodyMd\` (string, required) — the full new markdown body

Mutations happen through MCP tool calls — **not** fenced \`opencara-call\`
blocks (that legacy text channel was removed; emitting a fenced block
here does nothing). There is no HTTP request for you to make and no
token for you to manage.

## Semantics

- **\`bodyMd\` is the WHOLE markdown — never a fragment.** The full
  current body is provided to you as \`issue.bodyMd\` in the page
  context JSON. To make any edit, start from that full body, apply
  your change in place, and send the ENTIRE updated body back. If you
  call \`opencara_issue_body_set\` with just a snippet, the rest of
  the issue is erased — that is a bug, not a feature.
- \`issue.bodyMd\` reflects the CURRENTLY VISIBLE state — the unsaved
  draft if one exists, or the GitHub-mirrored body otherwise. Always
  rebase your rewrite on what the user is actually looking at, not on
  the published version.
- **\`selection\` is a REFERENCE, not a payload.** When the user has
  text selected, the page context carries it as
  \`selection.text\` (also mirrored at \`canvas.selection.text\`).
  Treat it as "the user is pointing at this passage in the body" —
  use it to locate the region to edit inside \`issue.bodyMd\`. Do NOT
  send the selection back as the new \`bodyMd\`; that would replace
  the entire issue with the selected snippet.
- The published body on GitHub is unchanged until the user clicks
  "Save to GitHub" in the UI.
- The tool returns \`"ok"\` on success or \`"rejected: <reason>"\` on
  failure — surface failures back to the user verbatim instead of
  claiming the change succeeded.

## Out of scope today

Title, labels, assignees, state, comments. The only mutation available
from this skill is \`opencara_issue_body_set\`.
`;
  return {
    name: "opencara-issue-edit",
    instructions,
    baseUrl,
    runId: opts.runId,
  };
}
