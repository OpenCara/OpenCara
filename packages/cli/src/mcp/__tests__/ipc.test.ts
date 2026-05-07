// IpcServer + IpcClient over a real Unix socket. These tests exercise:
//   - Round-trip framing (one message in, matching response out)
//   - Concurrent in-flight calls correlated by callId — the
//     "concurrent runs from the same device" risk the issue calls out
//     (this is the per-connection version; cross-run isolation is
//     enforced at the path level by per-run socket paths)
//   - Domain rejection (`{ ok: false, reason }`) round-trips intact
//   - Server-side handler exception → reported as transport-error result
//     to the client, doesn't bring down the connection
//
// We use the OS tmp dir + a randomized name per test to avoid
// cross-test stale-socket interference.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { resolve as pathResolve } from "node:path";
import { randomBytes } from "node:crypto";
import {
  IpcClient,
  IpcServer,
  type ToolCallFrame,
  type ToolResultFrame,
} from "../ipc.js";

function uniqueSocketPath(): string {
  return pathResolve(tmpdir(), `opencara-mcp-test-${randomBytes(6).toString("hex")}.sock`);
}

async function pair(handler: (call: ToolCallFrame) => Promise<ToolResultFrame["result"]>) {
  const socketPath = uniqueSocketPath();
  const server = new IpcServer({ socketPath, handler });
  await server.start();
  const client = new IpcClient(socketPath);
  await client.connect();
  return {
    socketPath,
    server,
    client,
    async close() {
      client.close();
      await server.stop();
    },
  };
}

describe("Ipc round-trip", () => {
  it("forwards a tool call and returns the matching result", async () => {
    const p = await pair(async (call) => {
      assert.equal(call.kind, "issue.body.set");
      assert.deepEqual(call.args, { issueNumber: 1, bodyMd: "x" });
      return { ok: true };
    });
    try {
      const result = await p.client.call("issue.body.set", { issueNumber: 1, bodyMd: "x" });
      assert.deepEqual(result, { ok: true });
    } finally {
      await p.close();
    }
  });

  it("preserves domain rejection through the wire", async () => {
    const p = await pair(async () => ({ ok: false, reason: "scope check failed" }));
    try {
      const result = await p.client.call("issue.body.set", { issueNumber: 0, bodyMd: "" });
      assert.deepEqual(result, { ok: false, reason: "scope check failed" });
    } finally {
      await p.close();
    }
  });

  it("correlates concurrent calls by callId without crosstalk", async () => {
    // Fan out 5 calls; the handler resolves them in REVERSE order so any
    // crosstalk would deliver wrong results to wrong callers.
    const inflight: Array<{ args: Record<string, unknown>; resolve: (r: ToolResultFrame["result"]) => void }> = [];
    const p = await pair(
      async (call) =>
        new Promise<ToolResultFrame["result"]>((resolve) => {
          inflight.push({ args: call.args, resolve });
        }),
    );
    try {
      const promises = [0, 1, 2, 3, 4].map((i) =>
        p.client.call("issue.body.set", { issueNumber: i, bodyMd: "x" }),
      );
      // Wait until all 5 calls have been received server-side.
      const start = Date.now();
      while (inflight.length < 5 && Date.now() - start < 1000) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.equal(inflight.length, 5);
      // Resolve in reverse, with caller-identifying reason text.
      for (let i = inflight.length - 1; i >= 0; i--) {
        inflight[i]!.resolve({ ok: false, reason: `r${(inflight[i]!.args["issueNumber"] as number)}` });
      }
      const results = await Promise.all(promises);
      // Each promise's resolution must match its issueNumber, not some
      // other in-flight call.
      for (let i = 0; i < results.length; i++) {
        assert.deepEqual(results[i], { ok: false, reason: `r${i}` });
      }
    } finally {
      await p.close();
    }
  });

  it("server-side handler exceptions surface as transport-error results", async () => {
    const p = await pair(async () => {
      throw new Error("boom");
    });
    try {
      const result = await p.client.call("issue.body.set", { issueNumber: 0, bodyMd: "" });
      assert.equal(result.ok, false);
      if (!result.ok) assert.match(result.reason, /transport error: boom/);
    } finally {
      await p.close();
    }
  });

  it("rejects pending calls when the connection drops", async () => {
    const socketPath = uniqueSocketPath();
    let resolveServer: (() => void) | null = null;
    const server = new IpcServer({
      socketPath,
      handler: () =>
        new Promise<ToolResultFrame["result"]>(() => {
          // Never resolves — we'll close the connection out from under it.
          if (resolveServer) resolveServer();
        }),
    });
    await server.start();
    const client = new IpcClient(socketPath);
    await client.connect();

    const seen = new Promise<void>((r) => (resolveServer = r));
    const callPromise = client.call("issue.body.set", { issueNumber: 1, bodyMd: "x" });
    await seen;
    client.close();
    await assert.rejects(callPromise, /disconnected/);
    await server.stop();
  });
});
