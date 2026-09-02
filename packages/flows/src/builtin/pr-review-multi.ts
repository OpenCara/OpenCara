import type { FlowDefinition } from "../types.js";

// PR extras every reviewer gets. The synthesizer needs none of them — its
// input is the concatenated reviewer outputs delivered on stdin.
const reviewerContext = {
  env: [
    "OPENCARA_REPO",
    "OPENCARA_PR_NUMBER",
    "OPENCARA_PR_HEAD_SHA",
    "OPENCARA_PR_BASE_SHA",
  ],
  stdinJson: true,
};

// Stage 2a: the full multi-agent review on PR open / reopen (or on demand
// via `@opencara mreview`). Follow-up pushes (synchronize) are handled by the
// lighter `pr-review` flow, so `synchronize` is intentionally NOT in this
// trigger's actions — the two flows are mutually exclusive by trigger and
// never double-post on one event.
//
// The review itself is ONE agent-pool node: an ordered list of agents sharing
// one prompt, N of them in parallel (the target number of reviews), per-agent
// retries and failover to the next in the list, and a minimum-success count.
// A synthesizer fans the successful reviews in (one section per agent) to a
// single posted review. Node ids match the legacy unified graph's stage so
// account-scope settings carry over 1:1.
export const prReviewMultiFlow: FlowDefinition = {
  slug: "pr-review-multi",
  name: "Multi-agent pull request review",
  description:
    "On PR opened/reopened (or `@opencara mreview`), run the reviewer agent pool — an ordered list of agents sharing one prompt, N in parallel with per-agent retry and failover — then synthesize the successful reviews into one posted PR review. Set the trigger's grace period to cancel the review if the PR is merged or gets an ignored label first.",
  nodes: [
    {
      id: "review_trigger",
      kind: "scm.pull_request",
      position: { x: 0, y: 0 },
      config: {
        actions: ["opened", "reopened", "commented"],
        branches: [],
        branchesIgnore: [],
        paths: [],
        pathsIgnore: [],
        labels: [],
        labelsIgnore: [],
        ignoreDrafts: false,
        commentPhrase: "@opencara mreview",
        delaySeconds: 0,
      },
    },
    {
      // Agent POOL: the operator links the primary agent + an ordered list of
      // fallbacks and sets how many run in parallel (node settings, not graph
      // config — agents are user-scoped). All share this node's prompt.
      id: "reviewer",
      kind: "agent",
      position: { x: 320, y: 0 },
      config: {
        label: "Reviewer pool",
        draftPr: false,
        contextInjection: reviewerContext,
      },
    },
    {
      id: "review_synthesizer",
      kind: "agent",
      position: { x: 640, y: 0 },
      config: {
        label: "Review synthesizer",
        draftPr: false,
        contextInjection: {
          // No PR env extras — input is the concatenated reviewer outputs
          // delivered via stdin (one section per successful pool agent).
          env: [],
          stdinJson: true,
        },
      },
    },
    {
      id: "post_review",
      kind: "scm.post_review",
      position: { x: 960, y: 0 },
      config: { event: "COMMENT" },
    },
  ],
  edges: [
    { id: "e_review", source: "review_trigger", target: "reviewer" },
    { id: "e_reviewer_synth", source: "reviewer", target: "review_synthesizer" },
    { id: "e_post", source: "review_synthesizer", target: "post_review" },
  ],
};
