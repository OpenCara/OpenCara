// AcpConnection tests — drive the routing/correlation core directly with an
// in-memory writable + manual feed(). No child process, no real binary.
//
// AcpClient (the wrapper that owns the spawn) is exercised by the spike
// harness against a live binary in development. Splitting the test surface
// at AcpConnection keeps these unit tests deterministic and fast.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { AcpClient, AcpConnection } from "../client.js";
import {
  encodeFrame,
} from "../framing.js";
import type {
  JsonRpcMessage,
  JsonRpcRequest,
  JsonRpcResponse,
  JsonRpcSuccess,
} from "../jsonrpc.js";
import { JSON_RPC_ERROR_METHOD_NOT_FOUND } from "../jsonrpc.js";
import type { SessionNotificationParams } from "../types.js";
import { ACP_METHODS, ACP_PROTOCOL_VERSION } from "../types.js";

function harness() {
  const written: JsonRpcMessage[] = [];
  const conn = new AcpConnection(
    {
      write(chunk) {
        // The connection writes one frame at a time, but we still split on
        // \n to be explicit about the wire shape we're asserting on.
        for (const line of chunk.split("\n")) {
          if (line.trim() === "") continue;
          written.push(JSON.parse(line) as JsonRpcMessage);
        }
      },
    },
    /* trace */ true,
  );
  return { conn, written };
}

describe("AcpConnection.request", () => {
  it("writes a JSON-RPC request and resolves on the matching response", async () => {
    const { conn, written } = harness();

    const promise = conn.initialize({ protocolVersion: ACP_PROTOCOL_VERSION });

    assert.equal(written.length, 1);
    const req = written[0] as JsonRpcRequest;
    assert.equal(req.jsonrpc, "2.0");
    assert.equal(req.method, ACP_METHODS.initialize);
    assert.deepEqual(req.params, { protocolVersion: ACP_PROTOCOL_VERSION });
    assert.equal(typeof req.id, "number");

    const reply: JsonRpcSuccess = {
      jsonrpc: "2.0",
      id: req.id,
      result: { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: {} },
    };
    conn.feed(encodeFrame(reply));

    const result = await promise;
    assert.deepEqual(result, { protocolVersion: ACP_PROTOCOL_VERSION, agentCapabilities: {} });
  });

  it("rejects when the response carries an error", async () => {
    const { conn, written } = harness();
    const promise = conn.prompt({ sessionId: "s1", prompt: [{ type: "text", text: "hi" }] });
    const req = written.at(-1) as JsonRpcRequest;
    const reply: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: req.id,
      error: { code: -32000, message: "boom" },
    };
    conn.feed(encodeFrame(reply));
    await assert.rejects(promise, /session\/prompt: boom \(-32000\)/);
  });

  it("uses sequential numeric ids per request", async () => {
    const { conn, written } = harness();
    void conn.initialize({ protocolVersion: ACP_PROTOCOL_VERSION });
    void conn.newSession({ cwd: "/tmp", mcpServers: [] });
    void conn.prompt({ sessionId: "s", prompt: [] });
    const ids = written.map((m) => (m as JsonRpcRequest).id);
    assert.deepEqual(ids, [1, 2, 3]);
  });

  it("rejects pending requests on shutdown", async () => {
    const { conn } = harness();
    const p = conn.initialize({ protocolVersion: ACP_PROTOCOL_VERSION });
    conn.shutdown("test");
    await assert.rejects(p, /closed/);
  });
});

describe("AcpConnection.notify", () => {
  it("session/cancel writes a notification (no id, no reply expected)", () => {
    const { conn, written } = harness();
    conn.cancel("session-xyz");
    assert.equal(written.length, 1);
    const msg = written[0]!;
    assert.equal(msg.jsonrpc, "2.0");
    assert.equal((msg as { method: string }).method, ACP_METHODS.session_cancel);
    assert.equal("id" in msg, false);
  });
});

describe("AcpConnection inbound dispatch", () => {
  it("emits sessionUpdate for session/update notifications", () => {
    const { conn } = harness();
    const seen: SessionNotificationParams[] = [];
    conn.onSessionUpdate((p) => seen.push(p));

    conn.feed(
      encodeFrame({
        jsonrpc: "2.0",
        method: ACP_METHODS.session_update,
        params: {
          sessionId: "s1",
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "hi" } },
        },
      }),
    );

    assert.equal(seen.length, 1);
    assert.equal(seen[0]!.sessionId, "s1");
    assert.equal(seen[0]!.update.sessionUpdate, "agent_message_chunk");
  });

  it("replies method-not-found to unsolicited agent→client requests", () => {
    const { conn, written } = harness();
    // Agent asks the client to read a file — we said we don't support it.
    conn.feed(
      encodeFrame({
        jsonrpc: "2.0",
        id: 99,
        method: ACP_METHODS.fs_read_text_file,
        params: { sessionId: "s", path: "/etc/passwd" },
      }),
    );
    const reply = written.at(-1) as JsonRpcResponse;
    assert.equal(reply.id, 99);
    assert.equal("error" in reply, true);
    if ("error" in reply) {
      assert.equal(reply.error.code, JSON_RPC_ERROR_METHOD_NOT_FOUND);
    }
  });

  it("ignores responses with unknown ids without crashing", () => {
    const { conn } = harness();
    // No pending request — just a stray reply. Must not throw.
    conn.feed(
      encodeFrame({
        jsonrpc: "2.0",
        id: 4242,
        result: {},
      }),
    );
  });

  it("emits malformed lines to the malformed listener", () => {
    const { conn } = harness();
    const lines: string[] = [];
    conn.onMalformed((l) => lines.push(l));
    conn.feed("not json\n");
    assert.deepEqual(lines, ["not json"]);
  });

  it("frame trace fires for both directions", () => {
    const { conn, written } = harness();
    const frames: Array<{ dir: string; method?: string }> = [];
    conn.onFrame((dir, m) => frames.push({ dir, method: (m as { method?: string }).method }));

    void conn.initialize({ protocolVersion: ACP_PROTOCOL_VERSION });
    const req = written.at(-1) as JsonRpcRequest;
    conn.feed(encodeFrame({ jsonrpc: "2.0", id: req.id, result: { protocolVersion: ACP_PROTOCOL_VERSION } }));

    assert.equal(frames.some((f) => f.dir === "out" && f.method === ACP_METHODS.initialize), true);
    assert.equal(frames.some((f) => f.dir === "in" && f.method === undefined), true);
  });

  it("auto-allows session/request_permission with the first allow_once option", () => {
    const { conn, written } = harness();
    conn.feed(
      encodeFrame({
        jsonrpc: "2.0",
        id: 7,
        method: ACP_METHODS.session_request_permission,
        params: {
          sessionId: "s1",
          toolCall: { toolCallId: "t1" },
          options: [
            { kind: "reject_once", name: "Deny once", optionId: "deny" },
            { kind: "allow_once", name: "Allow once", optionId: "allow" },
            { kind: "allow_always", name: "Always", optionId: "always" },
          ],
        },
      } as unknown as JsonRpcRequest),
    );
    const reply = written.at(-1) as JsonRpcSuccess;
    assert.equal(reply.id, 7);
    assert.deepEqual(reply.result, {
      outcome: { outcome: "selected", optionId: "allow" },
    });
  });

  it("falls back to cancelled when no allow option is offered (defensive)", () => {
    const { conn, written } = harness();
    conn.feed(
      encodeFrame({
        jsonrpc: "2.0",
        id: 8,
        method: ACP_METHODS.session_request_permission,
        params: {
          sessionId: "s1",
          toolCall: { toolCallId: "t1" },
          options: [{ kind: "reject_once", name: "Deny", optionId: "d" }],
        },
      } as unknown as JsonRpcRequest),
    );
    const reply = written.at(-1) as JsonRpcSuccess;
    assert.equal(reply.id, 8);
    assert.deepEqual(reply.result, { outcome: { outcome: "cancelled" } });
  });

  it("treats request-shaped frames with id:null as fire-and-forget (no reply)", () => {
    const { conn, written } = harness();
    conn.feed(
      encodeFrame({
        jsonrpc: "2.0",
        // Some agents may send request-shaped frames with id:null for
        // notification-like behavior. JSON-RPC forbids null ids on real
        // requests; we don't send a reply that would have id:null either.
        id: null,
        method: "weird/notify",
        params: {},
      } as unknown as JsonRpcRequest),
    );
    assert.equal(written.length, 0);
  });
});

describe("AcpClient pre-start listener registration", () => {
  // Regression for the spike harness order: register listeners → call
  // start(). Before this fix, those registrations threw because the
  // connection didn't exist yet.
  it("buffers onSessionUpdate / onFrame / onMalformed before start()", () => {
    const client = new AcpClient({ command: "echo", args: ["unused"] });
    // None of these may throw — start() is never called in this test, so
    // the queued listeners simply sit until GC. We verify the registration
    // path is safe pre-start; the post-start delivery path is exercised
    // end-to-end by the spike harness against a real binary.
    assert.doesNotThrow(() => client.onSessionUpdate(() => undefined));
    assert.doesNotThrow(() => client.onFrame(() => undefined));
    assert.doesNotThrow(() => client.onMalformed(() => undefined));
    assert.doesNotThrow(() => client.onStderr(() => undefined));
  });

  // close() before start() should be a clean no-op so callers don't have to
  // track lifecycle defensively (e.g. error during arg parsing).
  it("close() before start() resolves without throwing", async () => {
    const client = new AcpClient({ command: "echo" });
    const exit = await client.close();
    assert.equal(exit.code, null);
    assert.equal(exit.signal, null);
  });
});
