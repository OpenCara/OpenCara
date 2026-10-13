// Pins that every per-agent setting on the agents row survives the flow
// run's hand-off into buildAgentSpec. agentSpec.test.ts covers the builder
// itself; this covers the call-site projection in nodeRunners, which is
// where a newly added column is most easily forgotten.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { flowAgentSpecInput } from "../nodeRunners.js";
import { buildAgentSpec } from "../../agents/agentSpec.js";

const row = {
  name: "sonnet reviewer",
  model: "anthropic/claude-sonnet-5-5",
  cwd: "/home/agent",
  captureThinking: false,
  thoughtLevel: "high",
};

describe("flowAgentSpecInput", () => {
  it("forwards model, thoughtLevel and captureThinking into the turn", () => {
    const spec = buildAgentSpec({
      agent: flowAgentSpecInput(row, null),
      env: {},
      systemPromptMd: "s",
      userPromptMd: "u",
    });
    assert.equal(spec.kind, "sonnet reviewer");
    assert.equal(spec.turn?.model, "anthropic/claude-sonnet-5-5");
    assert.equal(spec.turn?.thoughtLevel, "high");
    assert.equal(spec.turn?.captureThinking, false);
  });

  it("prefers the worktree workdir over the agent's cwd", () => {
    assert.equal(flowAgentSpecInput(row, "/wt/branch").cwd, "/wt/branch");
    assert.equal(flowAgentSpecInput(row, null).cwd, "/home/agent");
    assert.equal(flowAgentSpecInput({ ...row, cwd: null }, null).cwd, null);
  });
});
