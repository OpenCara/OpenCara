import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentCallRequest } from "@opencara/shared";
import { AgentCallBridge } from "../opencaraTools.js";

const call = { kind: "issue.body.set", issueNumber: 1, bodyMd: "x" } as const;

describe("AgentCallBridge", () => {
  it("resolves a call with its own run's result only", async () => {
    const sent: AgentCallRequest[] = [];
    const bridge = new AgentCallBridge("run-a", (req) => sent.push(req));
    const pending = bridge.call(call, undefined);
    const { callId } = sent[0]!;
    bridge.onResult({ type: "agent-call-result", runId: "run-b", callId, result: { ok: true } });
    bridge.onResult({
      type: "agent-call-result",
      runId: "run-a",
      callId,
      result: { ok: false, reason: "out of scope" },
    });
    assert.deepEqual(await pending, { ok: false, reason: "out of scope" });
    assert.deepEqual(sent, [{ type: "agent-call-request", runId: "run-a", callId, ...call }]);
  });

  it("gives up on a call when the turn is aborted or ends", async () => {
    const bridge = new AgentCallBridge("run-a", () => {});
    const abort = new AbortController();
    const aborted = bridge.call(call, abort.signal);
    const orphaned = bridge.call(call, undefined);
    abort.abort();
    bridge.shutdown("turn ended");
    assert.deepEqual(await aborted, { ok: false, reason: "aborted" });
    assert.deepEqual(await orphaned, { ok: false, reason: "turn ended" });
  });
});
