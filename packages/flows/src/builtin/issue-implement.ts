import type { FlowDefinition } from "../types.js";

// Stage 1 of the development cycle: a Projects v2 issue moving to Ready
// dispatches the implement agent in a fresh worktree on the derived
// `opencara/issue-<n>` branch. The agent commits, pushes and opens the PR;
// the PR-opened webhook then wakes the `pr-review-multi` flow. Node ids are
// shared with the (now legacy) unified `development-lifecycle` graph so
// account-scope settings carry over 1:1.
export const issueImplementFlow: FlowDefinition = {
  slug: "issue-implement",
  name: "Issue → Implement",
  description:
    "A Projects v2 issue moving to Ready dispatches the implement agent in a per-issue-branch worktree; it commits, pushes, and opens the PR. Label the issue `agent:<name>` to pick a specific agent per item. Configure the agent pool (primary, fallbacks, retries) on the node.",
  nodes: [
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
  ],
  edges: [{ id: "e_impl", source: "implement_trigger", target: "implement" }],
};
