import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  CancelJobSchema,
  HelloAckSchema,
  HOST_PROTOCOL_VERSION,
  MIN_HOST_PROTOCOL_VERSION,
  SERVER_TO_DEVICE_TYPES,
} from "@opencara/shared";
import { classifyServerFrame } from "../ws-client.js";

describe("classifyServerFrame", () => {
  it("parses a known frame", () => {
    const r = classifyServerFrame(JSON.stringify({ type: "ping" }));
    assert.equal(r.kind, "ok");
    if (r.kind === "ok") assert.equal(r.msg.type, "ping");
  });

  it("classifies an unrecognized type as unknown-type (newer server), not malformed", () => {
    const r = classifyServerFrame(
      JSON.stringify({ type: "shiny-new-frame", payload: 42 }),
    );
    assert.deepEqual(r, { kind: "unknown-type", type: "shiny-new-frame" });
  });

  it("classifies a known type failing schema parse as malformed", () => {
    // `cancel` without runId — a real wire bug, must be loud.
    const r = classifyServerFrame(JSON.stringify({ type: "cancel" }));
    assert.equal(r.kind, "malformed");
  });

  it("classifies non-JSON as malformed", () => {
    assert.equal(classifyServerFrame("not json{").kind, "malformed");
  });

  it("parses a hello-ack without protocolVersion (old server)", () => {
    const r = classifyServerFrame(
      JSON.stringify({ type: "hello-ack", agentHostId: "h", deviceName: "d" }),
    );
    assert.equal(r.kind, "ok");
  });
});

describe("forward-compatible schema parsing", () => {
  it("degrades an unknown cancel reason to user_stopped instead of failing the frame", () => {
    // A future server sends reason:"timeout" — pre-versioning CLIs dropped
    // the whole frame here and the job became unkillable.
    const r = classifyServerFrame(
      JSON.stringify({ type: "cancel", runId: "r1", reason: "timeout" }),
    );
    assert.equal(r.kind, "ok");
    if (r.kind === "ok" && r.msg.type === "cancel") {
      assert.equal(r.msg.reason, "user_stopped");
    }
  });

  it("CancelJobSchema itself applies the reason fallback", () => {
    const parsed = CancelJobSchema.parse({
      type: "cancel",
      runId: "r1",
      reason: "something-from-the-future",
    });
    assert.equal(parsed.reason, "user_stopped");
  });

  it("hello-ack accepts and surfaces the server protocolVersion", () => {
    const parsed = HelloAckSchema.parse({
      type: "hello-ack",
      agentHostId: "h",
      deviceName: "d",
      protocolVersion: 99,
    });
    assert.equal(parsed.protocolVersion, 99);
  });

  it("version constants are coherent", () => {
    assert.ok(HOST_PROTOCOL_VERSION >= 1);
    assert.ok(MIN_HOST_PROTOCOL_VERSION <= HOST_PROTOCOL_VERSION);
    // The known-types set must contain every frame the schema union accepts
    // (spot-check the members that existed at v1).
    for (const t of ["job", "hello-ack", "ping", "agent-call-result", "cancel"]) {
      assert.ok(SERVER_TO_DEVICE_TYPES.has(t), `missing ${t}`);
    }
  });
});
