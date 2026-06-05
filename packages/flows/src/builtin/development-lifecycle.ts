import type { FlowDefinition } from "../types.js";

// Shared by every reviewer node in the review fan-out. The synthesizer
// needs none of these PR extras — its input is the concatenated reviewer
// outputs delivered on stdin.
const reviewerContext = {
  env: [
    "OPENCARA_REPO",
    "OPENCARA_PR_NUMBER",
    "OPENCARA_PR_HEAD_SHA",
    "OPENCARA_PR_BASE_SHA",
  ],
  stdinJson: true,
};

// The unified development-lifecycle flow merges the four single-purpose
// built-ins (`issue-implement`, `pr-review`, `pr-review-multi`,
// `pr-review-fix`) into ONE graph that covers the whole development
// cycle: issue → PR → review → fix → auto-merge. (It was renamed from
// `issue-lifecycle` in migration 0034 — the old slug named only the
// entry point, but the flow spans the whole cycle, not just the issue.)
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
//   [pull_request] → [reviewer ×3] → [synthesize] → [post review]  (stage 2)
//
//   [pull_request_review] → [fix] (auto-merge)            (stage 3)
//
// Worktree / session continuity across stages is preserved exactly as
// it was across the old issue-implement + pr-review-fix pair: both the
// implement and fix agents resolve the SAME per-(repo, branch) worktree
// (`opencara/issue-<n>`), so the fix agent reuses the implementer's
// checkout and resumes its conversation from `agent-session.json`.
//
// The review stage is a multi-agent fan-out (absorbing the old
// `pr-review-multi`): the PR trigger lights up three reviewer agents
// (correctness, performance, style) in parallel; a synthesizer fans them
// in to one summary, which `post_review` posts as a single PR comment.
// Link a different agent to each reviewer node from the flow detail page;
// drop reviewer nodes (and their edges) to collapse back toward a single
// reviewer.
//
// Review → fix loop: the fix agent pushing commits emits
// `pull_request.synchronize`, which the review stage's trigger picks up
// (a fresh review → another fix). This is the same review/push cycle the
// old `pr-review` + `pr-review-fix` pair ran on; it converges when the
// fix agent reaches a no-op (empty diff, nothing left to address), and
// the duplicate-run dedupe (issue #147 / migration 0031) bounds repeated
// deliveries of the same event. The fix stage's `maxIterations` block is
// the engine-level backstop — left disabled by default to match the
// legacy flow, but an operator can enable it (with `commentOnSkip`) to
// hard-cap fix iterations per PR.
export const developmentLifecycleFlow: FlowDefinition = {
  slug: "development-lifecycle",
  name: "Development lifecycle",
  description:
    "The full development lifecycle in one flow: a Projects v2 issue moving to Ready dispatches the implement agent in a per-PR-branch worktree (it commits, pushes, and opens the PR); the PR opening fans out to three reviewer agents (correctness, performance, style) whose reviews a synthesizer merges into one posted review; submitting that review (or an `@opencara fix` comment) wakes the same implement agent in the same worktree to apply the feedback and optionally auto-merge. Three trigger entry-points route each webhook to the matching stage — only that stage runs, so there are no `trigger_skip` runs for the other stages. Label an issue/PR `agent:<name>` to pick a specific agent per-item; link a different agent to each reviewer node from the flow detail page.",
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
      id: "reviewer_correctness",
      kind: "agent",
      position: { x: 320, y: 140 },
      config: {
        label: "Correctness reviewer",
        draftPr: false,
        contextInjection: reviewerContext,
      },
    },
    {
      id: "reviewer_performance",
      kind: "agent",
      position: { x: 320, y: 240 },
      config: {
        label: "Performance reviewer",
        draftPr: false,
        contextInjection: reviewerContext,
      },
    },
    {
      id: "reviewer_style",
      kind: "agent",
      position: { x: 320, y: 340 },
      config: {
        label: "Style reviewer",
        draftPr: false,
        contextInjection: reviewerContext,
      },
    },
    {
      id: "review_synthesizer",
      kind: "agent",
      position: { x: 640, y: 240 },
      config: {
        label: "Review synthesizer",
        draftPr: false,
        contextInjection: {
          // No PR env extras — input is the concatenated reviewer outputs
          // delivered via stdin (fan-in over the three reviewer nodes).
          env: [],
          stdinJson: true,
        },
      },
    },
    {
      id: "post_review",
      kind: "github.post_review",
      position: { x: 960, y: 240 },
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
    // Review stage fan-out → synthesize → post.
    { id: "e_review_c", source: "review_trigger", target: "reviewer_correctness" },
    { id: "e_review_p", source: "review_trigger", target: "reviewer_performance" },
    { id: "e_review_s", source: "review_trigger", target: "reviewer_style" },
    { id: "e_c_synth", source: "reviewer_correctness", target: "review_synthesizer" },
    { id: "e_p_synth", source: "reviewer_performance", target: "review_synthesizer" },
    { id: "e_s_synth", source: "reviewer_style", target: "review_synthesizer" },
    { id: "e_post", source: "review_synthesizer", target: "post_review" },
    { id: "e_fix", source: "fix_trigger", target: "fix" },
  ],
};
