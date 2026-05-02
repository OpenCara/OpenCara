import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type { FlowDefinition } from "../types.js";

const here = dirname(fileURLToPath(import.meta.url));
// dist/builtin/issue-implement.js → ../../examples/echo-implementer.mjs
const echoImplementerPath = resolve(here, "../../examples/echo-implementer.mjs");

export const issueImplementFlow: FlowDefinition = {
  slug: "issue-implement",
  name: "Issue → Implement",
  description:
    "When a Projects v2 issue moves to Ready (or any chosen Status option), dispatch the implement agent with the issue's title, body, labels, and assignees on stdin. Add an `agent:<name>` label to the issue (e.g. `agent:claude-impl`) to pick a specific agent per-issue; without that label, the agent linked on this node runs as the default.",
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
  ],
  edges: [{ id: "e1", source: "t1", target: "a1" }],
};
