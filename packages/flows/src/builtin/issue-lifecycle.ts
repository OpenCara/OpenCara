import type { FlowDefinition } from "../types.js";

// The unified issue-lifecycle flow merges the four single-purpose
// built-ins (`issue-implement`, `pr-review`, `pr-review-multi`,
// `pr-review-fix`) into ONE graph that covers the whole issue → PR →
// review → fix → auto-merge pipeline.
//
// The graph has THREE trigger entry-points, one per lifecycle stage.
// The engine activates only the subgraph rooted at the trigger that
// matched the incoming webhook (see FlowEngine.executeFlow +
// computeActiveSubgraph); the other entry-points are pruned for that
// event rather than spawning a cancelled `trigger_skip` run. That's
// what removes the noise of dispatching every event to four flows and
// cancelling three of them (issue #124).
//
// The stages are linked by GitHub side-effects, NOT in-graph edges:
//   stage 1's agent opens a PR  → GitHub emits `pull_request.opened` → stage 2
//   stage 2 posts a review      → GitHub emits `pull_request_review`  → stage 3
// Each round-trip re-enters the engine as a fresh event that lights up
// the matching entry-point. Keeping the three subgraphs as disconnected
// components (each its own trigger root) is what lets a single event
// run exactly one stage.
//
//   [projects_v2_item] → [implement]                      (stage 1)
//
//   [pull_request]     → [reviewer] → [post review]       (stage 2)
//
//   [pull_request_review] → [fix] (auto-merge)            (stage 3)
//
// Worktree / session continuity across stages is preserved exactly as
// it was across the old issue-implement + pr-review-fix pair: both the
// implement and fix agents resolve the SAME per-(repo, branch) worktree
// (`opencara/issue-<n>`), so the fix agent reuses the implementer's
// checkout and resumes its conversation from `agent-session.json`.
//
// The single reviewer node is the common case. To run the multi-agent
// fan-out (the old `pr-review-multi`), add reviewer nodes + a
// synthesizer from the flow detail page — the review stage exposes the
// reviewer controls just like the standalone multi-review template did.
export const issueLifecycleFlow: FlowDefinition = {
  slug: "issue-lifecycle",
  name: "Issue lifecycle",
  description:
    "The full issue lifecycle in one flow: a Projects v2 issue moving to Ready dispatches the implement agent in a per-PR-branch worktree (it commits, pushes, and opens the PR); the PR opening fires the reviewer agent, which posts a review; submitting that review (or an `@opencara fix` comment) wakes the same implement agent in the same worktree to apply the feedback and optionally auto-merge. Three trigger entry-points route each webhook to the matching stage — only that stage runs, so there are no `trigger_skip` runs for the other stages. Label an issue/PR `agent:<name>` to pick a specific agent per-item; add reviewer nodes to the review stage for a multi-agent fan-out review.",
  nodes: [
    // ── Stage 1: issue → implement ──────────────────────────────────
    {
      id: "implement_trigger",
      kind: "github.projects_v2_item",
      position: { x: 0, y: 0 },
      config: {
        projectNumber: null,
        fieldName: "Status",
        toOptions: ["Ready"],
        fromOptions: [],
        contentTypes: ["Issue"],
      },
    },
    {
      id: "implement",
      kind: "agent",
      position: { x: 320, y: 0 },
      config: {
        label: "Implement agent",
        draftPr: false,
        contextInjection: {
          env: [
            "OPENCARA_REPO",
            "OPENCARA_ISSUE_NUMBER",
            "OPENCARA_ISSUE_NODE_ID",
            "OPENCARA_STATUS_FROM",
            "OPENCARA_STATUS_TO",
            "OPENCARA_WORKTREE_DIR",
            "OPENCARA_WORKTREE_BRANCH",
            "OPENCARA_SESSION_DIR",
          ],
          stdinJson: true,
        },
        worktree: {
          fromBranch: null, // = repo's default branch
          branchName: "opencara/issue-{{OPENCARA_ISSUE_NUMBER}}",
          hostId: null,
        },
      },
    },

    // ── Stage 2: PR opened → review ─────────────────────────────────
    {
      id: "review_trigger",
      kind: "github.pull_request",
      position: { x: 0, y: 220 },
      config: {
        actions: ["opened", "synchronize", "reopened", "commented"],
        branches: [],
        branchesIgnore: [],
        paths: [],
        pathsIgnore: [],
        labels: [],
        labelsIgnore: [],
        ignoreDrafts: false,
        commentPhrase: "@opencara review",
      },
    },
    {
      id: "reviewer",
      kind: "agent",
      position: { x: 320, y: 220 },
      config: {
        label: "Reviewer agent",
        draftPr: false,
        contextInjection: {
          env: [
            "OPENCARA_REPO",
            "OPENCARA_PR_NUMBER",
            "OPENCARA_PR_HEAD_SHA",
            "OPENCARA_PR_BASE_SHA",
          ],
          stdinJson: true,
        },
      },
    },
    {
      id: "post_review",
      kind: "github.post_review",
      position: { x: 640, y: 220 },
      config: { event: "COMMENT" },
    },

    // ── Stage 3: review submitted → fix (+ auto-merge) ──────────────
    {
      id: "fix_trigger",
      kind: "github.pull_request_review",
      position: { x: 0, y: 440 },
      config: {
        reviewStates: ["commented", "changes_requested"],
        users: ["opencara[bot]"],
        commentPhrase: "@opencara fix",
      },
    },
    {
      id: "fix",
      kind: "agent",
      position: { x: 320, y: 440 },
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
        // Same branchName template as the implement stage (the PR's head
        // ref equals `opencara/issue-<n>`), so the per-(repo, branch) pin
        // lands this iteration on the implementer's device + checkout,
        // where the agent-session.json lives.
        worktree: {
          fromBranch: "{{OPENCARA_PR_HEAD_REF}}",
          branchName: "{{OPENCARA_PR_HEAD_REF}}",
          hostId: null,
        },
      },
    },
  ],
  edges: [
    { id: "e_impl", source: "implement_trigger", target: "implement" },
    { id: "e_review", source: "review_trigger", target: "reviewer" },
    { id: "e_post", source: "reviewer", target: "post_review" },
    { id: "e_fix", source: "fix_trigger", target: "fix" },
  ],
};
