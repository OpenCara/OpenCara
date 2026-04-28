import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { FlowDefinition } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
// dist/builtin/pr-review.js → ../../examples/echo-reviewer.mjs
const echoReviewerPath = resolve(here, "../../examples/echo-reviewer.mjs");

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
      },
    },
    {
      id: "a1",
      kind: "agent",
      position: { x: 280, y: 0 },
      config: {
        label: "Reviewer agent",
        spec: {
          kind: "pr-reviewer",
          // v1 stub agent: emits a canned review markdown so the rest of the
          // pipeline can be exercised without an LLM call. Swap to `claude`
          // (or any other command) by editing this node config.
          command: "node",
          args: [echoReviewerPath],
          env: {},
        },
        contextInjection: {
          env: [
            "OPENKIRA_REPO",
            "OPENKIRA_PR_NUMBER",
            "OPENKIRA_PR_HEAD_SHA",
            "OPENKIRA_PR_BASE_SHA",
          ],
          stdinJson: true,
        },
        runOn: "any",
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
