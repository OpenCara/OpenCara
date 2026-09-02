import type { FlowDefinition } from "../types.js";

const reviewerContext = {
  env: [
    "OPENCARA_REPO",
    "OPENCARA_PR_NUMBER",
    "OPENCARA_PR_HEAD_SHA",
    "OPENCARA_PR_BASE_SHA",
  ],
  stdinJson: true,
};

// Stage 2b: the lighter single-reviewer pass on follow-up pushes
// (synchronize) — so the review → fix loop iterates with one cheap review —
// or on demand via `@opencara review`. First open / reopen is handled by
// `pr-review-multi`, so `opened` is intentionally NOT in this trigger's
// actions. (`@opencara review` is not a substring of `@opencara mreview`, so
// the two comment phrases don't collide.)
//
// The reviewer is an agent-pool node like any other: leave it at one slot for
// plain failover, or raise "run in parallel" to get several opinions here too.
// Node ids match the legacy unified graph's stage so account-scope settings
// carry over 1:1.
export const prReviewFlow: FlowDefinition = {
  slug: "pr-review",
  name: "Pull request review",
  description:
    "On PR synchronize (or `@opencara review`), run the single reviewer agent pool and post its review. Set the trigger's grace period to cancel the review if the PR is merged or gets an ignored label first.",
  nodes: [
    {
      id: "single_review_trigger",
      kind: "scm.pull_request",
      position: { x: 0, y: 0 },
      config: {
        actions: ["synchronize", "commented"],
        branches: [],
        branchesIgnore: [],
        paths: [],
        pathsIgnore: [],
        labels: [],
        labelsIgnore: [],
        ignoreDrafts: false,
        commentPhrase: "@opencara review",
        delaySeconds: 0,
      },
    },
    {
      id: "single_reviewer",
      kind: "agent",
      position: { x: 320, y: 0 },
      config: {
        label: "Single reviewer",
        draftPr: false,
        contextInjection: reviewerContext,
      },
    },
    {
      id: "single_post_review",
      kind: "scm.post_review",
      position: { x: 640, y: 0 },
      config: { event: "COMMENT" },
    },
  ],
  edges: [
    { id: "e_single_review", source: "single_review_trigger", target: "single_reviewer" },
    { id: "e_single_post", source: "single_reviewer", target: "single_post_review" },
  ],
};
