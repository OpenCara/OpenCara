// WsAgentCallBridge unit tests. We drive it with synthetic
// `agent-call-result` frames — no real WS — and assert correlation.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { AgentCallRequest, AgentCallResultMessage } from "@opencara/shared";
import { WsAgentCallBridge } from "../wsBridge.js";

function setup(runId = "run_x") {
  const sent: AgentCallRequest[] = [];
  const bridge = new WsAgentCallBridge({
    runId,
    sendRequest: (req) => sent.push(req),
  });
  return { bridge, sent };
}

describe("WsAgentCallBridge", () => {
  it("emits an agent-call-request and resolves on the matching result", async () => {
    const { bridge, sent } = setup("run_x");
    const promise = bridge.router.call("issue.body.set", {
      issueNumber: 7,
      bodyMd: "hi",
    });

    assert.equal(sent.length, 1);
    const req = sent[0]!;
    assert.equal(req.type, "agent-call-request");
    assert.equal(req.runId, "run_x");
    assert.equal(req.kind, "issue.body.set");
    if (req.kind === "issue.body.set") {
      assert.equal(req.issueNumber, 7);
      assert.equal(req.bodyMd, "hi");
    }

    const result: AgentCallResultMessage = {
      type: "agent-call-result",
      runId: "run_x",
      callId: req.callId,
      result: { ok: true },
    };
    bridge.onResult(result);

    assert.deepEqual(await promise, { ok: true });
  });

  it("ignores results for a different runId (cross-run isolation)", async () => {
    // Two bridges, one run each, sharing nothing. A result frame for the
    // wrong run must not resolve the wrong promise.
    const { bridge: a, sent: sentA } = setup("run_a");
    const { bridge: b } = setup("run_b");

    const pa = a.router.call("issue.body.set", { issueNumber: 1, bodyMd: "" });
    const reqA = sentA[0]!;

    // Stray result targeting run_b shouldn't touch a's pending map.
    b.onResult({
      type: "agent-call-result",
      runId: "run_b",
      callId: reqA.callId,
      result: { ok: false, reason: "wrong run" },
    });

    // Now resolve a properly.
    a.onResult({
      type: "agent-call-result",
      runId: "run_a",
      callId: reqA.callId,
      result: { ok: true },
    });
    assert.deepEqual(await pa, { ok: true });
  });

  it("correlates concurrent calls by callId", async () => {
    const { bridge, sent } = setup();
    const p1 = bridge.router.call("issue.body.set", { issueNumber: 1, bodyMd: "a" });
    const p2 = bridge.router.call("issue.body.set", { issueNumber: 2, bodyMd: "b" });
    const p3 = bridge.router.call("issue.body.set", { issueNumber: 3, bodyMd: "c" });
    assert.equal(sent.length, 3);

    // Resolve out of order.
    bridge.onResult({
      type: "agent-call-result",
      runId: "run_x",
      callId: sent[2]!.callId,
      result: { ok: false, reason: "third" },
    });
    bridge.onResult({
      type: "agent-call-result",
      runId: "run_x",
      callId: sent[0]!.callId,
      result: { ok: true },
    });
    bridge.onResult({
      type: "agent-call-result",
      runId: "run_x",
      callId: sent[1]!.callId,
      result: { ok: false, reason: "second" },
    });

    assert.deepEqual(await p1, { ok: true });
    assert.deepEqual(await p2, { ok: false, reason: "second" });
    assert.deepEqual(await p3, { ok: false, reason: "third" });
  });

  it("ignores stale callIds (replies for completed/unknown calls)", async () => {
    const { bridge } = setup();
    // No pending — must not throw, must not crash.
    bridge.onResult({
      type: "agent-call-result",
      runId: "run_x",
      callId: "ghost",
      result: { ok: true },
    });
  });

  it("returns a domain rejection for unknown kinds without sending a frame", async () => {
    const { bridge, sent } = setup();
    const result = await bridge.router.call("nonexistent.kind", {});
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.reason, /unknown agent-call kind/);
    assert.equal(sent.length, 0);
  });

  it("shutdown rejects every pending call", async () => {
    const { bridge } = setup();
    const p1 = bridge.router.call("issue.body.set", { issueNumber: 1, bodyMd: "" });
    const p2 = bridge.router.call("flow.node.config.set", {
      flowSlug: "f",
      nodeId: "n",
      config: {},
    });
    bridge.shutdown("run ended");
    await assert.rejects(p1, /bridge closed: run ended/);
    await assert.rejects(p2, /bridge closed: run ended/);
  });

  it("surfaces sendRequest failure as a rejection on the call promise", async () => {
    const bridge = new WsAgentCallBridge({
      runId: "run_x",
      sendRequest: () => {
        throw new Error("ws closed");
      },
    });
    await assert.rejects(
      bridge.router.call("issue.body.set", { issueNumber: 1, bodyMd: "" }),
      /ws closed/,
    );
  });
});
