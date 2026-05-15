import type { FlowDefinition } from "../types.js";

export const issueImplementFlow: FlowDefinition = {
  slug: "issue-implement",
  name: "Issue → Implement",
  description:
    "When a Projects v2 issue moves to Ready, dispatch the implement agent inside a per-PR-branch worktree. The agent reads the issue (title/body/labels/assignees on stdin) and is expected to: make changes, commit, push the branch, and run `gh pr create` to open the PR itself. Enable Create draft PR to have the agent open a draft first and the engine mark it ready after a successful run. The worktree persists across flow runs (so `pr-review-fix` reuses it) and is removed on `pull_request.closed`. Add an `agent:<name>` label to the issue (e.g. `agent:claude-impl`) to pick a specific agent per-issue; without that label, the agent linked on this node runs as the default.",
  nodes: [
    {
      id: "t1",
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
      id: "a1",
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
            "OPENCARA_PR_DRAFT",
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
  ],
  edges: [{ id: "e1", source: "t1", target: "a1" }],
};
