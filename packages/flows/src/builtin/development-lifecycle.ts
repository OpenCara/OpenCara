import type { FlowDefinition } from "../types.js";

// Shared by both reviewer nodes (the multi-review pool and the single
// reviewer). The synthesizer
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
//   [pull_request opened] → [reviewer pool] → [synthesize] → [post] (stage 2a, multi)
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
// Every agent attempt gets a fresh checkout: the implement agent works on
// the derived `opencara/issue-<n>` branch and pushes it; the fix agent
// later checks out the PR head ref (that same branch) into its own
// worktree. Context flows through the PR/issue conversation, not a shared
// working tree.
//
// The review stage is a multi-agent review driven by ONE agent-pool node
// (absorbing the old `pr-review-multi` fan-out): the `reviewer` node carries
// an ordered list of agents sharing one prompt plus a policy — how many run
// in parallel (also the target number of reviews), the minimum that must
// succeed, and per-agent retries before failing over to the next in the
// list. A synthesizer fans the successful reviews in (one section per
// agent) to one summary, which `post_review` posts as a single PR comment.
// Configure the pool from the flow detail page: link the primary agent,
// add fallbacks in priority order, set "run in parallel" to the number of
// reviews you want. The synthesizer and the other agent nodes accept the
// same pool settings (typically concurrency 1 = plain failover).
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
    "The full development lifecycle in one flow: a Projects v2 issue moving to Ready dispatches the implement agent in a per-PR-branch worktree (it commits, pushes, and opens the PR); opening the PR runs the reviewer agent pool — an ordered list of agents sharing one prompt, N of them in parallel with per-agent retry and failover to the next in the list — whose reviews a synthesizer merges into one posted review (multi review), while follow-up pushes run a lighter single reviewer; submitting a review (or an `@opencara fix` comment) wakes the same implement agent in the same worktree to apply the feedback and optionally auto-merge. The two review components are independent and mutually exclusive by trigger: multi fires on PR open/reopen or `@opencara mreview`, single fires on PR synchronize or `@opencara review`. Trigger entry-points route each webhook to exactly one stage, so there are no `trigger_skip` runs. Label an issue/PR `agent:<name>` to pick a specific agent per-item; configure each agent node's pool (primary, fallbacks, parallelism, minimum successes, retries) from the flow detail page.",
  nodes: [
    // ── Stage 1: issue → implement ──────────────────────────────────
    {
      id: "implement_trigger",
      kind: "scm.board_item",
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
      kind: "scm.pull_request",
      position: { x: 0, y: 620 },
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
      // fallbacks and sets how many run in parallel (flow_node_settings, not
      // graph config — agents are user-scoped). All share this node's prompt.
      id: "reviewer",
      kind: "agent",
      position: { x: 320, y: 620 },
      config: {
        label: "Reviewer pool",
        draftPr: false,
        contextInjection: reviewerContext,
      },
    },
    {
      id: "review_synthesizer",
      kind: "agent",
      position: { x: 640, y: 620 },
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
      position: { x: 960, y: 620 },
      config: { event: "COMMENT" },
    },

    // ── Stage 3: review submitted → fix (+ auto-merge) ──────────────
    {
      id: "fix_trigger",
      kind: "scm.pull_request_review",
      position: { x: 0, y: 360 },
      config: {
        reviewStates: ["commented", "changes_requested"],
        users: ["opencara[bot]"],
        commentPhrase: "@opencara fix",
      },
    },
    {
      id: "fix",
      kind: "agent",
      position: { x: 320, y: 360 },
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
        // PR trigger → the engine checks out the PR head ref (which the
        // implement stage pushed as `opencara/issue-<n>`).
        worktree: {
          fromBranch: null, // PR trigger: the PR head ref is checked out
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
      kind: "scm.pull_request",
      position: { x: 0, y: 200 },
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
      position: { x: 320, y: 200 },
      config: {
        label: "Single reviewer",
        draftPr: false,
        contextInjection: reviewerContext,
      },
    },
    {
      id: "single_post_review",
      kind: "scm.post_review",
      position: { x: 640, y: 200 },
      config: { event: "COMMENT" },
    },
  ],
  edges: [
    { id: "e_impl", source: "implement_trigger", target: "implement" },
    // Review stage fan-out → synthesize → post.
    { id: "e_review", source: "review_trigger", target: "reviewer" },
    { id: "e_reviewer_synth", source: "reviewer", target: "review_synthesizer" },
    { id: "e_post", source: "review_synthesizer", target: "post_review" },
    { id: "e_fix", source: "fix_trigger", target: "fix" },
    // Single-review component (independent of the multi fan-out).
    { id: "e_single_review", source: "single_review_trigger", target: "single_reviewer" },
    { id: "e_single_post", source: "single_reviewer", target: "single_post_review" },
  ],
};
