import type { FlowDefinition } from "../types.js";

export const prReviewFlow: FlowDefinition = {
  slug: "pr-review",
  name: "Pull request review",
  description:
    "On PR opened/synchronize, fetch the diff, run a reviewer agent, and post the agent output as a PR review comment.",
  nodes: [
    {
      id: "t1",
      kind: "github.pull_request",
      position: { x: 0, y: 0 },
      config: {
        actions: ["opened", "synchronize", "reopened"],
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
      id: "a1",
      kind: "agent",
      position: { x: 280, y: 0 },
      config: {
        label: "Reviewer agent",
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
      id: "x1",
      kind: "github.post_review",
      position: { x: 560, y: 0 },
      config: { event: "COMMENT" },
    },
  ],
  edges: [
    { id: "e1", source: "t1", target: "a1" },
    { id: "e2", source: "a1", target: "x1" },
  ],
};
