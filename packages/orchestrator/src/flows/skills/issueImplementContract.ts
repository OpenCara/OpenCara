import type { SkillEnvelope } from "../skills.js";

// Pure-markdown skill envelope injected into the agent's system prompt
// when an agent node both (a) has an issue context (Projects v2 status
// trigger) and (b) is configured with a worktree. That combination is
// the discriminator for an issue-implement-shaped run: the agent is
// expected to make code changes inside the worktree, commit, push the
// branch, and open the PR itself.
//
// The orchestrator's post-step (`linkPrToIssueAndCopyAgentLabel`)
// asserts the PR exists after the agent finishes. Without this
// instruction the model often stops at "edited the file" without
// shipping anything — which is the bug this skill closes.
export function buildIssueImplementContractSkill(opts: {
  baseUrl: string;
  runId: string;
  branchName: string;
  issueNumber: number;
  defaultBranch: string;
  draftPr: boolean;
}): SkillEnvelope {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const prCreateCmd = opts.draftPr
    ? `gh pr create --draft --base "${opts.defaultBranch}" --head "$OPENCARA_WORKTREE_BRANCH" --title "<title>" --body "<body>"`
    : `gh pr create --base "${opts.defaultBranch}" --head "$OPENCARA_WORKTREE_BRANCH" --title "<title>" --body "<body>"`;
  const draftNote = opts.draftPr
    ? `The PR MUST be opened as a draft (\`--draft\` flag included above);
   the engine will mark it ready for review after this run succeeds.`
    : `Do NOT pass \`--draft\` — this flow opens the PR ready for review.`;
  const instructions = `# Skill: opencara-issue-implement-contract

You are running inside a per-PR-branch worktree to implement the issue
described in the user prompt. Your job is not finished when the code
edit lands on disk — it is finished only when a pull request exists on
GitHub for the changes you made.

## Required completion contract

When your implementation is ready, you MUST perform all four of these
steps before exiting, in order:

1. \`git add\` the files you changed (or \`git add -A\` if you also
   created new files that belong in the diff). Use the existing
   \`$OPENCARA_WORKTREE_DIR\` checkout — do not clone elsewhere.
2. \`git commit -m "<concise message>"\`. Use one or more commits.
   Empty commits are fine if a prior iteration already pushed the
   diff; the push below is still required.
3. \`git push -u origin "$OPENCARA_WORKTREE_BRANCH"\` to publish the
   branch. The orchestrator authenticated \`gh\` / \`git\` for you via
   \`GH_TOKEN\` — no extra credentials needed.
4. \`${prCreateCmd}\`
   to open the PR. ${draftNote}
   Include the literal line \`Closes #${opts.issueNumber}\` in the body so
   GitHub links the PR to the source issue.

If a PR for this branch already exists (a re-run of the same flow on
the same issue), \`gh pr create\` will fail with "already exists" —
that's fine, treat it as success and skip to exiting. Do NOT close
and re-open the PR.

## Env vars you can rely on

- \`OPENCARA_WORKTREE_DIR\` — the working directory (this is also your
  CWD; \`pwd\` will match).
- \`OPENCARA_WORKTREE_BRANCH\` — the branch to push and open the PR
  from (\`${opts.branchName}\`).
- \`OPENCARA_ISSUE_NUMBER\` — the source issue (\`${opts.issueNumber}\`).
- \`OPENCARA_REPO\` — \`<owner>/<repo>\`. \`gh\` already infers this
  from the worktree's remote; you do not normally need to pass
  \`--repo\`.

## What NOT to do

- Do not edit files outside \`$OPENCARA_WORKTREE_DIR\`.
- Do not call the \`opencara_issue_body_set\` MCP tool here — that tool
  belongs to the chat/canvas UI, not webhook-driven flow runs.
- Do not stop after editing files. A clean diff with no commit / no
  push / no PR is the failure mode this contract exists to prevent;
  the orchestrator will mark the flow run failed when no PR is found
  on the branch.

## Why this contract is enforced

After your run, the orchestrator queries GitHub for an open PR on
\`$OPENCARA_WORKTREE_BRANCH\`. If none exists, the flow run is marked
failed with a message naming the missing PR, so a follow-up review-fix
iteration can pick up where you left off. (Run id: ${opts.runId})
`;
  return {
    name: "opencara-issue-implement-contract",
    instructions,
    baseUrl,
    runId: opts.runId,
  };
}
