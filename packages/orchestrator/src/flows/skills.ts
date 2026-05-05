// "Skills" are markdown documents we inject into an agent's stdin alongside
// the user's prompt, describing the API the agent can act on while its run
// is live. Today there's exactly one skill — issue-edit for the canvas
// page. The shape is intentionally extensible so flow-side agents
// (PR review, issue-implement) can adopt the same pattern.
//
// Auth model: the agent never holds a token. It emits a structured fenced
// block on stdout; the CLI parses the block and proxies the call back to
// the orchestrator over its already-authed WebSocket connection.

export interface IssueCanvasSkillOpts {
  baseUrl: string;
  projectId: string;
  issueNumber: number;
}

export interface SkillEnvelope {
  /** Stable identifier the agent author can match on. */
  name: string;
  /** Markdown describing what the skill exposes and how to invoke it. */
  instructions: string;
  /** Resolved API base — informational only; the agent doesn't make HTTP
   * calls itself. Useful for log/debug output. */
  baseUrl: string;
  /** The agent's run id, useful for log correlation. */
  runId: string;
}

export function buildIssueCanvasSkill(
  opts: IssueCanvasSkillOpts & { runId: string },
): SkillEnvelope {
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
