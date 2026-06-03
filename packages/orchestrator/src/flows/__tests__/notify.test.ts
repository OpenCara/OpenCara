import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseFlowRunsNotify,
  serializeFlowRunsNotify,
  type FlowRunsNotify,
} from "../notify.js";

describe("flow_runs notify payload", () => {
  it("round-trips a payload through serialize/parse", () => {
    const n: FlowRunsNotify = { flowRunId: "01JRUN", projectId: "01JPROJ" };
    assert.deepEqual(parseFlowRunsNotify(serializeFlowRunsNotify(n)), n);
  });

  it("returns null for a bare (non-JSON) string payload", () => {
    // Legacy/foreign payloads must not masquerade as a valid notify — callers
    // decide how to degrade (run-scoped ignores, project-scoped rebuilds).
    assert.equal(parseFlowRunsNotify("01JRUN"), null);
  });

  it("returns null when required fields are missing or mistyped", () => {
    assert.equal(parseFlowRunsNotify(JSON.stringify({ flowRunId: "x" })), null);
    assert.equal(
      parseFlowRunsNotify(JSON.stringify({ projectId: "x" })),
      null,
    );
    assert.equal(
      parseFlowRunsNotify(JSON.stringify({ flowRunId: 1, projectId: 2 })),
      null,
    );
    assert.equal(parseFlowRunsNotify("null"), null);
  });
});
