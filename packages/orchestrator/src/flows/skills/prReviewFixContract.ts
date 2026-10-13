import type { SkillEnvelope } from "../skills.js";

// Pure-markdown skill envelope injected into the agent's system prompt
// when an agent node both (a) has a PR context (pull_request /
// pull_request_review / comment-on-PR trigger) and (b) is configured
// with a worktree — but does NOT feed a downstream `scm.post_review`
// node. That combination is the discriminator for a review-fix-shaped
// run: the agent is expected to commit its edits and push them back to
// the PR's head branch, which the worktree already has checked out.
//
// Why the post_review exclusion: reviewer agents run in PR-head-ref
// worktrees too (they build and exercise the code under review), so
// worktree+prContext alone cannot tell a fixer from a reviewer — but a
// reviewer's output is text consumed by `scm.post_review`, while a
// fixer's output is the pushed commit itself. The event type can't
// discriminate either: `@opencara fix` and `@opencara review` comments
// both arrive as issue_comment.
//
// The stock "Fix PR Review Issues" prompt forbids commit/push "unless
// the surrounding workflow explicitly requests it" — this skill IS that
// explicit request. Without it the agent edits, validates, reports, and
// exits; the per-attempt worktree teardown then silently deletes every
// change (ShiningPie PR 115, run 01M3RPMK1KHZ5JE7S6PPTKVMH0, 2026-09-30:
// 45 minutes of correct, validated fixes destroyed — the run still
// reported `succeeded` and the remote branch never moved).
export function buildPrReviewFixContractSkill(opts: {
  baseUrl: string;
  runId: string;
  branchName: string;
}): SkillEnvelope {
  const instructions = `# Skill: opencara-pr-review-fix-contract

You are running inside a per-attempt worktree checked out on the pull
request's head branch. Your job is not finished when the code edits
land on disk — it is finished only when your commits have been pushed
back to the PR branch on the remote. The pull request already exists;
you are updating it, not creating it.

## Required completion contract

When your fixes are ready, and ONLY if your work produced file changes,
you MUST perform these steps before exiting, in order:

1. \`git add\` the files you changed (or \`git add -A\` if you also
   created new files that belong in the diff). Use the existing
   \`$OPENCARA_WORKTREE_DIR\` checkout — do not clone elsewhere.
2. \`git commit -m "<concise message>"\`. Use one or more commits.
3. \`git push -u origin "$OPENCARA_WORKTREE_BRANCH"\` to publish onto
   the PR's head branch. The worktree's credential helper is already
   configured and \`OPENCARA_SCM_TOKEN\` is in your environment — no
   extra credentials are needed, and this works for both GitHub and
   Azure DevOps remotes.

If the push is rejected as non-fast-forward, someone pushed to the
branch while you were working: run
\`git pull --rebase origin "$OPENCARA_WORKTREE_BRANCH"\`, re-run your
checks, then push again.

If every review item turned out invalid or out of scope and you changed
nothing, skip the commit/push and say so in your final response — an
empty diff is a legitimate outcome, not a failure.

## Env vars you can rely on

- \`OPENCARA_WORKTREE_DIR\` — the working directory (this is also your
  CWD; \`pwd\` will match).
- \`OPENCARA_WORKTREE_BRANCH\` — the PR's head branch
  (\`${opts.branchName}\`); the push target.
- \`OPENCARA_PR_NUMBER\` — the pull request being updated.

## What NOT to do

- Do not edit files outside \`$OPENCARA_WORKTREE_DIR\`.
- Do not open a new pull request — this run updates the existing one.
- Do not merge, close, approve, or request changes on the PR — review
  actions belong to reviewer agents, not fixers.
- Do not amend or force-push over commits already under review; add new
  commits on top so reviewers can diff the delta.
- Do not stop after editing files. A validated diff with no commit and
  no push is the failure mode this contract exists to prevent — the
  worktree is deleted when your run ends, so unpushed work is
  unrecoverable.

## Why pushing matters

Your push to the PR branch emits a pull_request.synchronize event,
which re-triggers the review stage for the next iteration. Without the
push there is no re-review and no forward progress — the flow run
succeeds while the fix evaporates. (Run id: ${opts.runId})
`;
  return {
    name: "opencara-pr-review-fix-contract",
    instructions,
    baseUrl: opts.baseUrl,
    runId: opts.runId,
  };
}
