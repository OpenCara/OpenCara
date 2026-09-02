import type { FlowDefinition } from "../types.js";

// Stage 3: a submitted review (or an `@opencara fix` comment) wakes the
// implement agent again — in the SAME per-(repo, branch) worktree the
// `issue-implement` flow allocated, resuming its conversation from
// `agent-session.json` — to apply the feedback and optionally auto-merge.
//
// The fix agent pushing commits emits `pull_request.synchronize`, which the
// `pr-review` flow picks up for the next lighter review round; `maxIterations`
// is the engine-level backstop on that loop (disabled by default). Node ids
// match the legacy unified graph's stage so account-scope settings carry over.
export const prReviewFixFlow: FlowDefinition = {
  slug: "pr-review-fix",
  name: "PR review → Fix",
  description:
    "When a review is submitted on the PR (commented / changes requested by default) or someone comments `@opencara fix`, wake the implement agent in the PR's worktree to apply the feedback, then optionally auto-merge. maxIterations caps the review → fix loop per PR.",
  nodes: [
    {
      id: "fix_trigger",
      kind: "scm.pull_request_review",
      position: { x: 0, y: 0 },
      config: {
        reviewStates: ["commented", "changes_requested"],
        users: ["opencara[bot]"],
        commentPhrase: "@opencara fix",
      },
    },
    {
      id: "fix",
      kind: "agent",
      position: { x: 320, y: 0 },
      config: {
        label: "Fix agent",
        draftPr: false,
        autoMerge: {
          enabled: false,
          method: "squash",
          requireChecks: true,
          requireApproval: false,
          mergeWithoutChanges: false,
        },
        maxIterations: {
          enabled: false,
          limit: null,
          commentOnSkip: false,
        },
        contextInjection: {
          env: [
            "OPENCARA_REPO",
            "OPENCARA_PR_NUMBER",
            "OPENCARA_PR_HEAD_REF",
            "OPENCARA_PR_HEAD_SHA",
            "OPENCARA_PR_BASE_SHA",
            "OPENCARA_REVIEW_STATE",
            "OPENCARA_REVIEW_BODY",
            "OPENCARA_REVIEW_AUTHOR",
            "OPENCARA_COMMENT_BODY",
            "OPENCARA_COMMENT_AUTHOR",
            "OPENCARA_COMMENT_HTML_URL",
            "OPENCARA_WORKTREE_DIR",
            "OPENCARA_WORKTREE_BRANCH",
            "OPENCARA_SESSION_DIR",
          ],
          stdinJson: true,
        },
        // Same branchName template as the implement stage (the PR's head ref
        // equals `opencara/issue-<n>`), so the per-(repo, branch) pin lands
        // this iteration on the implementer's device + checkout, where the
        // agent-session.json lives.
        worktree: {
          fromBranch: "{{OPENCARA_PR_HEAD_REF}}",
          branchName: "{{OPENCARA_PR_HEAD_REF}}",
          hostId: null,
        },
      },
    },
  ],
  edges: [{ id: "e_fix", source: "fix_trigger", target: "fix" }],
};
