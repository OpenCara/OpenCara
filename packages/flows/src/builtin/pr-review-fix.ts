import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { FlowDefinition } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
// dist/builtin/pr-review-fix.js → ../../examples/echo-implementer.mjs
const echoImplementerPath = resolve(here, "../../examples/echo-implementer.mjs");

// Wakes the implementer agent up when a reviewer leaves a review on
// a PR opened by the issue-implement flow. The agent runs in the
// SAME worktree (same device, same checkout) as the implementer —
// `worktree create` is idempotent and `worktree_pins(repo, branch)`
// keeps the device pinned. With kind != "custom", the per-kind
// adapter resumes the conversation from `agent-session.json` left
// behind by the implementer, applies the feedback, and pushes more
// commits to the same branch. GitHub's review/push cycle is the
// "loop"; no engine-side iteration cap.
//
// Pair this flow with kind=claude/codex/opencode/pi so the adapter
// can wire `--resume <id>`. kind=custom starts a fresh conversation
// each iteration (no resume).
export const prReviewFixFlow: FlowDefinition = {
  slug: "pr-review-fix",
  name: "PR review → Fix (resume)",
  description:
    "When a reviewer submits a review on a PR opened by `issue-implement`, dispatch the same agent that opened the PR to apply the feedback. The agent runs on the same device, in the same worktree, with its prior conversation resumed (kind-aware, see `agent.kind`). The review body and state are surfaced via `OPENCARA_REVIEW_BODY` / `OPENCARA_REVIEW_STATE` env vars and on stdin. The agent commits and pushes to the existing PR branch — it does NOT open a new PR.",
  nodes: [
    {
      id: "t1",
      kind: "github.pull_request_review",
      position: { x: 0, y: 0 },
      config: {
        // Default: fire on commented + changes_requested. Approved
        // reviews don't need a fix iteration; dismissed don't either.
        // Operators can broaden / narrow this in the trigger panel.
        reviewStates: ["commented", "changes_requested"],
      },
    },
    {
      id: "a1",
      kind: "agent",
      position: { x: 320, y: 0 },
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
        // Same branchName template as the implement flow (the PR's
        // head ref equals `opencara/issue-<n>`). The per-(repo,
        // branch) pin makes the second iteration land on the
        // implementer's device + checkout, where the
        // agent-session.json file is.
        worktree: {
          fromBranch: "{{OPENCARA_PR_HEAD_REF}}",
          branchName: "{{OPENCARA_PR_HEAD_REF}}",
          hostId: null,
        },
      },
    },
  ],
  edges: [{ id: "e1", source: "t1", target: "a1" }],
};
