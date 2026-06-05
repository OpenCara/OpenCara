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
// The graph has FOUR trigger entry-points across the lifecycle stages.
// The engine activates only the subgraph rooted at the trigger that
// matched the incoming webhook (see FlowEngine.executeFlow +
// computeActiveSubgraph); the other entry-points are pruned for that
// event rather than spawning a cancelled `trigger_skip` run. That's
// what removes the noise of dispatching every event to four flows and
// cancelling three of them (issue #124).
//
// The stages are linked by GitHub side-effects, NOT in-graph edges:
//   stage 1's agent opens a PR  → GitHub emits `pull_request.opened` → stage 2a
//   a review is posted          → GitHub emits `pull_request_review`  → stage 3
//   the fix agent pushes        → GitHub emits `pull_request.synchronize` → stage 2b
// Each round-trip re-enters the engine as a fresh event that lights up
// the matching entry-point. Keeping the subgraphs as disconnected
// components (each its own trigger root) is what lets a single event
// run exactly one stage.
//
//   [projects_v2_item] → [implement]                               (stage 1)
//
//   [pull_request opened] → [reviewer ×3] → [synthesize] → [post]  (stage 2a, multi)
//
//   [pull_request synchronize] → [reviewer] → [post]               (stage 2b, single)
//
//   [pull_request_review] → [fix] (auto-merge)                     (stage 3)
//
// Two INDEPENDENT review components share the `pull_request` event but are
// mutually exclusive by trigger, so only one ever runs per event (no double
// post): the MULTI fan-out (2a) fires on `opened`/`reopened` or the comment
// `@opencara mreview`; the SINGLE reviewer (2b) fires on `synchronize` or the
// comment `@opencara review`. (`@opencara review` is not a substring of
// `@opencara mreview`, so the comment phrases don't collide.)
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
// `pull_request.synchronize`, which the SINGLE-review trigger (2b) picks up
// (a fresh single review → another fix). Iterations use the cheaper single
// review; the multi fan-out only runs on the first open. It converges when the
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
    "The full development lifecycle in one flow: a Projects v2 issue moving to Ready dispatches the implement agent in a per-PR-branch worktree (it commits, pushes, and opens the PR); opening the PR fans out to three reviewer agents (correctness, performance, style) whose reviews a synthesizer merges into one posted review (multi review), while follow-up pushes run a lighter single reviewer; submitting a review (or an `@opencara fix` comment) wakes the same implement agent in the same worktree to apply the feedback and optionally auto-merge. The two review components are independent and mutually exclusive by trigger: multi fires on PR open/reopen or `@opencara mreview`, single fires on PR synchronize or `@opencara review`. Trigger entry-points route each webhook to exactly one stage, so there are no `trigger_skip` runs. Label an issue/PR `agent:<name>` to pick a specific agent per-item; link a different agent to each reviewer node from the flow detail page.",
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

    // ── Stage 2a: PR opened → MULTI review ──────────────────────────
    // Full fan-out review on first open / reopen, or on demand via the
    // `@opencara mreview` comment. Follow-up pushes (synchronize) are handled
    // by the lighter single-review component below, so `synchronize` is
    // intentionally NOT in this trigger's actions.
    {
      id: "review_trigger",
      kind: "github.pull_request",
      position: { x: 0, y: 220 },
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

    // ── Stage 2b: PR synchronize → SINGLE review ────────────────────
    // An independent, single-reviewer component (its own trigger, own post),
    // totally separate from the multi fan-out above. It fires on follow-up
    // pushes (synchronize) — so the review → fix loop iterates with one cheap
    // review — or on demand via the `@opencara review` comment.
    {
      id: "single_review_trigger",
      kind: "github.pull_request",
      position: { x: 0, y: 660 },
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
      },
    },
    {
      id: "single_reviewer",
      kind: "agent",
      position: { x: 320, y: 660 },
      config: {
        label: "Single reviewer",
        draftPr: false,
        contextInjection: reviewerContext,
      },
    },
    {
      id: "single_post_review",
      kind: "github.post_review",
      position: { x: 640, y: 660 },
      config: { event: "COMMENT" },
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
    // Single-review component (independent of the multi fan-out).
    { id: "e_single_review", source: "single_review_trigger", target: "single_reviewer" },
    { id: "e_single_post", source: "single_reviewer", target: "single_post_review" },
  ],
};
