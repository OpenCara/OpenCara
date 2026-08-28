import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePriorSession } from "../nodeRunners.js";
import { AGENT_KINDS } from "../../agents/kinds.js";

describe("parsePriorSession", () => {
  // The regression this guards: the allowlist used to be a hand-written
  // literal, so adding `omp`/`cursor` left both kinds unable to resume — with
  // no type error (the literal stays assignable to the widened union) and no
  // runtime signal. Assert against AGENT_KINDS so the next kind is covered the
  // moment it is registered.
  it("accepts every registered agent kind", () => {
    for (const kind of AGENT_KINDS) {
      assert.deepEqual(parsePriorSession({ kind, id: "sess-1" }), {
        kind,
        id: "sess-1",
      });
    }
  });

  it("rejects unregistered kinds and malformed payloads", () => {
    assert.equal(parsePriorSession({ kind: "custom", id: "sess-1" }), null);
    assert.equal(parsePriorSession({ kind: "nope", id: "sess-1" }), null);
    assert.equal(parsePriorSession({ kind: "claude" }), null);
    assert.equal(parsePriorSession({ kind: "claude", id: 7 }), null);
    assert.equal(parsePriorSession(null), null);
    assert.equal(parsePriorSession("claude"), null);
    assert.equal(parsePriorSession(undefined), null);
  });
});
