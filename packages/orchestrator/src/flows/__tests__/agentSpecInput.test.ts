// Pins that every per-agent setting on the agents row survives the flow
// run's hand-off into buildAcpSpec. The acp-gate tests cover the builder
// itself; this covers the call-site projection in nodeRunners, which is
// where a newly added column is most easily forgotten.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flowAgentSpecInput } from "../nodeRunners.js";
import { buildAcpSpec } from "../../agents/acp-gate.js";

const row = {
  kind: "claude",
  name: "claude reviewer",
  cwd: "/home/agent",
  args: ["--model", "claude-sonnet-5"],
  acpArgs: null,
  captureThinking: false,
  thoughtLevel: "high",
};

describe("flowAgentSpecInput", () => {
  it("forwards thoughtLevel and captureThinking into the acp spec", () => {
    const spec = buildAcpSpec({
      agent: flowAgentSpecInput(row, null),
      env: {},
      systemPromptMd: "s",
      userPromptMd: "u",
    });
    assert.equal(spec.acp?.thoughtLevel, "high");
    assert.equal(spec.acp?.captureThinking, false);
  });

  it("prefers the worktree workdir over the agent's cwd", () => {
    assert.equal(flowAgentSpecInput(row, "/wt/branch").cwd, "/wt/branch");
    assert.equal(flowAgentSpecInput(row, null).cwd, "/home/agent");
    assert.equal(flowAgentSpecInput({ ...row, cwd: null }, null).cwd, null);
  });
});
