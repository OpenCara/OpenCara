import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAgentSpec } from "../agentSpec.js";

const baseOpts = {
  agent: { name: "sonnet", model: "anthropic/claude-sonnet-5-5", cwd: "/wt/branch" },
  env: { ANTHROPIC_API_KEY: "k" },
  systemPromptMd: "system",
  userPromptMd: "user",
};

describe("buildAgentSpec", () => {
  it("builds an agent turn labelled with the agent name and no argv", () => {
    const spec = buildAgentSpec(baseOpts);
    assert.equal(spec.kind, "sonnet");
    assert.equal(spec.command, undefined);
    assert.deepEqual(spec.args, []);
    assert.equal(spec.cwd, "/wt/branch");
    assert.deepEqual(spec.turn, {
      model: "anthropic/claude-sonnet-5-5",
      systemPromptMd: "system",
      userPromptMd: "user",
      history: [],
      images: [],
    });
  });

  it("threads priorConversationId when set and omits it otherwise", () => {
    assert.equal(
      buildAgentSpec({ ...baseOpts, priorConversationId: "conv-1" }).turn?.priorConversationId,
      "conv-1",
    );
    for (const priorConversationId of [undefined, ""]) {
      const spec = buildAgentSpec({ ...baseOpts, priorConversationId });
      assert.equal("priorConversationId" in (spec.turn ?? {}), false);
    }
  });

  it("serializes pageContext only when it has keys", () => {
    assert.equal(
      buildAgentSpec({ ...baseOpts, pageContext: { route: "/x" } }).turn?.pageContextJson,
      '{"route":"/x"}',
    );
    const empty = buildAgentSpec({ ...baseOpts, pageContext: {} });
    assert.equal("pageContextJson" in (empty.turn ?? {}), false);
  });

  it("sends captureThinking only when it is false", () => {
    const off = buildAgentSpec({ ...baseOpts, agent: { ...baseOpts.agent, captureThinking: false } });
    assert.equal(off.turn?.captureThinking, false);
    for (const captureThinking of [true, undefined]) {
      const spec = buildAgentSpec({ ...baseOpts, agent: { ...baseOpts.agent, captureThinking } });
      assert.equal("captureThinking" in (spec.turn ?? {}), false);
    }
  });

  it("sends a trimmed thoughtLevel and omits null / empty", () => {
    const high = buildAgentSpec({ ...baseOpts, agent: { ...baseOpts.agent, thoughtLevel: " high " } });
    assert.equal(high.turn?.thoughtLevel, "high");
    for (const thoughtLevel of [null, "", "   ", undefined]) {
      const spec = buildAgentSpec({ ...baseOpts, agent: { ...baseOpts.agent, thoughtLevel } });
      assert.equal("thoughtLevel" in (spec.turn ?? {}), false);
    }
  });
});
