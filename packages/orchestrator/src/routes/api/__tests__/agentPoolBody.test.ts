import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KEEP, parseAgentPoolPatch } from "../agentPoolBody.js";

describe("parseAgentPoolPatch", () => {
  it("leaves every absent field alone", () => {
    assert.deepEqual(parseAgentPoolPatch({}), {
      fallbackAgentIds: KEEP,
      retrySame: KEEP,
      concurrency: KEEP,
      preferred: KEEP,
      quorum: KEEP,
    });
  });

  it("takes the three pool numbers and clamps them to the accepted range", () => {
    const patch = parseAgentPoolPatch({ concurrency: 3, preferred: 99, quorum: 2 });
    assert.deepEqual(patch, {
      fallbackAgentIds: KEEP,
      retrySame: KEEP,
      concurrency: 3,
      preferred: 8,
      quorum: 2,
    });
  });

  it("an explicit null clears `preferred` back to following concurrency", () => {
    const patch = parseAgentPoolPatch({ preferred: null });
    assert.equal("error" in patch ? patch.error : patch.preferred, null);
  });

  it("rejects a non-numeric preferred instead of coercing it", () => {
    assert.match(
      (parseAgentPoolPatch({ preferred: "3" }) as { error: string }).error,
      /preferred must be a number or null/,
    );
  });
});
