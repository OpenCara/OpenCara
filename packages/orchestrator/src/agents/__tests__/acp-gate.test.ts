import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildAcpSpec, checkAcpEligibility } from "../acp-gate.js";

const baseOpts = {
  agent: { kind: "claude", name: "claude-default", cwd: "/wt/branch" },
  env: {},
  systemPromptMd: "system",
  userPromptMd: "user",
};

describe("buildAcpSpec priorSessionId", () => {
  it("threads priorSessionId onto the AcpSpec when set", () => {
    const spec = buildAcpSpec({ ...baseOpts, priorSessionId: "abc-123" });
    assert.equal(spec.acp?.priorSessionId, "abc-123");
  });

  it("omits priorSessionId entirely when not set (clean wire shape)", () => {
    const spec = buildAcpSpec({ ...baseOpts });
    assert.equal(spec.acp?.priorSessionId, undefined);
    assert.equal("priorSessionId" in (spec.acp ?? {}), false);
  });

  it("omits priorSessionId when explicitly undefined (no zero-value pollution)", () => {
    const spec = buildAcpSpec({ ...baseOpts, priorSessionId: undefined });
    assert.equal("priorSessionId" in (spec.acp ?? {}), false);
  });
});

describe("checkAcpEligibility", () => {
  it("accepts known kinds", () => {
    assert.equal(checkAcpEligibility("claude").useAcp, true);
    assert.equal(checkAcpEligibility("codex").useAcp, true);
  });

  it("rejects unknown kinds with a refuseReason", () => {
    const r = checkAcpEligibility("custom");
    assert.equal(r.useAcp, false);
    assert.match(r.refuseReason ?? "", /not supported/);
  });
});
