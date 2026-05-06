import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { FlowDefinition } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
// dist/builtin/pr-review-fix.js → ../../examples/echo-implementer.mjs
const echoImplementerPath = resolve(here, "../../examples/echo-implementer.mjs");

// Wakes the implementer agent up when a reviewer leaves a review on a
// PR opened by the issue-implement flow. The worktree node clones the
// PR's existing head branch (no new branch created), and the agent
// node — pinned to the device that ran the original implementation,
// reading its prior session id from `~/.opencara/sessions/<.../>` —
// resumes the same conversation, applies the feedback, and pushes
// more commits to the same branch. GitHub's review/push cycle is the
// "loop"; no engine-side iteration cap.
//
// Pair this flow with an agent of kind != "custom" (claude/codex/
// opencode/pi) so the per-kind adapter can wire `--resume <id>`. A
// kind=custom agent will start a fresh conversation each iteration.
export const prReviewFixFlow: FlowDefinition = {
  slug: "pr-review-fix",
  name: "PR review → Fix (resume)",
  description:
    "When a reviewer submits a review on a PR opened by `issue-implement`, dispatch the same agent that opened the PR to apply the feedback. The agent runs on the same device with its prior conversation resumed (kind-aware, see `agent.kind`). The review body and state are surfaced via `OPENCARA_REVIEW_BODY` / `OPENCARA_REVIEW_STATE` env vars and on stdin.",
  nodes: [
    {
      id: "t1",
      kind: "github.pull_request",
      position: { x: 0, y: 0 },
      config: {
        actions: ["review_submitted"],
        branches: [],
        branchesIgnore: [],
        paths: [],
        pathsIgnore: [],
        labels: [],
        labelsIgnore: [],
        ignoreDrafts: false,
        // Default: fire on commented + changes_requested. Approved
        // reviews don't need a fix iteration; dismissed don't either.
        // Operators can broaden / narrow this in the trigger panel.
        reviewStates: ["commented", "changes_requested"],
      },
    },
    {
      id: "w1",
      kind: "git.create_worktree",
      position: { x: 280, y: 0 },
      config: {
        // Clone the PR's existing head branch in place — the worktree
        // node detects fromBranch == branchName and skips `checkout -b`.
        fromBranch: "{{OPENCARA_PR_HEAD_REF}}",
        branchName: "{{OPENCARA_PR_HEAD_REF}}",
        hostId: null,
      },
    },
    {
      id: "a1",
      kind: "agent",
      position: { x: 560, y: 0 },
      config: {
        label: "Fix agent",
        spec: {
          kind: "review-fix",
          // Stub. Link a kind={claude|codex|opencode|pi} agent on the
          // node detail page to enable conversation resume.
          command: "node",
          args: [echoImplementerPath],
          env: {},
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
            "OPENCARA_WORKTREE_DIR",
            "OPENCARA_WORKTREE_BRANCH",
            "OPENCARA_SESSION_DIR",
          ],
          stdinJson: true,
        },
      },
    },
  ],
  edges: [
    { id: "e1", source: "t1", target: "w1" },
    { id: "e2", source: "w1", target: "a1" },
  ],
};
