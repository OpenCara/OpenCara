import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { FlowDefinition } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
// dist/builtin/issue-implement.js → ../../examples/echo-implementer.mjs
const echoImplementerPath = resolve(here, "../../examples/echo-implementer.mjs");

export const issueImplementFlow: FlowDefinition = {
  slug: "issue-implement",
  name: "Issue → Implement → PR",
  description:
    "When a Projects v2 issue moves to Ready, allocate a fresh git worktree on a paired device, run the implement agent inside it (with the issue's title, body, labels, and assignees on stdin), and open a draft PR from the worktree branch. Add an `agent:<name>` label to the issue (e.g. `agent:claude-impl`) to pick a specific agent per-issue; without that label, the agent linked on this node runs as the default. The worktree is removed when the run finishes.",
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
      id: "w1",
      kind: "git.create_worktree",
      position: { x: 280, y: 0 },
      config: {
        fromBranch: null, // = repo's default branch
        branchName: "opencara/issue-{{OPENCARA_ISSUE_NUMBER}}",
        hostId: null,
      },
    },
    {
      id: "a1",
      kind: "agent",
      position: { x: 560, y: 0 },
      config: {
        label: "Implement agent",
        spec: {
          kind: "issue-implement",
          // Stub mirrors echo-reviewer: emits a canned plan markdown so the
          // pipeline can be exercised end-to-end without an LLM. Link a real
          // agent (e.g. `claude --print "..."`) via the flow node settings to
          // replace this.
          command: "node",
          args: [echoImplementerPath],
          env: {},
        },
        contextInjection: {
          env: [
            "OPENCARA_REPO",
            "OPENCARA_ISSUE_NUMBER",
            "OPENCARA_ISSUE_NODE_ID",
            "OPENCARA_STATUS_FROM",
            "OPENCARA_STATUS_TO",
          ],
          stdinJson: true,
        },
      },
    },
    {
      id: "p1",
      kind: "github.create_pull_request",
      position: { x: 840, y: 0 },
      config: {
        title: "WIP: implement issue #{{OPENCARA_ISSUE_NUMBER}}",
        body: null, // = use the implement agent's stdout as the PR body
        baseBranch: null, // = repo's default branch
        draft: true,
      },
    },
  ],
  edges: [
    { id: "e1", source: "t1", target: "w1" },
    { id: "e2", source: "w1", target: "a1" },
    { id: "e3", source: "a1", target: "p1" },
  ],
};
