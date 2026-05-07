// McpHost lifecycle tests. We don't actually spawn opencara-mcp here —
// that's the spike-harness territory and depends on a real ACP agent.
// Instead we verify the host's own lifecycle (start/stop, idempotence)
// and the shape of `acpServerEntry()` — the ACP `mcpServers` config
// chat path will hand to `session/new` in #29.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { resolve as pathResolve } from "node:path";
import { randomBytes } from "node:crypto";
import { McpHost } from "../host.js";

function uniquePath(): string {
  return pathResolve(tmpdir(), `opencara-host-test-${randomBytes(6).toString("hex")}.sock`);
}

describe("McpHost", () => {
  it("start() opens the IPC socket; stop() removes it", async () => {
    const socketPath = uniquePath();
    const host = new McpHost({
      runId: "run_a",
      router: { async call() { return { ok: true }; } },
      socketPath,
    });
    await host.start();
    assert.equal(existsSync(socketPath), true);
    await host.stop();
    assert.equal(existsSync(socketPath), false);
  });

  it("start()/stop() are idempotent", async () => {
    const host = new McpHost({
      runId: "run_b",
      router: { async call() { return { ok: true }; } },
      socketPath: uniquePath(),
    });
    await host.start();
    await host.start(); // no-op, must not throw
    await host.stop();
    await host.stop(); // no-op, must not throw
  });

  it("acpServerEntry() returns ACP mcpServers config with the runtime socket path", () => {
    const socketPath = uniquePath();
    const host = new McpHost({
      runId: "run_c",
      router: { async call() { return { ok: true }; } },
      socketPath,
      mcpCommand: "node",
      mcpArgs: ["dist/opencara-mcp.js"],
    });
    const entry = host.acpServerEntry();
    assert.equal(entry.type, "stdio");
    assert.equal(entry.name, "opencara");
    assert.equal(entry.command, "node");
    assert.deepEqual(entry.args, ["dist/opencara-mcp.js"]);
    const ipcEnv = entry.env.find((e) => e.name === "OPENCARA_MCP_IPC_SOCKET");
    assert.equal(ipcEnv?.value, socketPath);
  });

  it("default mcp invocation falls back to tsx + the source bin path", () => {
    const host = new McpHost({
      runId: "run_d",
      router: { async call() { return { ok: true }; } },
    });
    const entry = host.acpServerEntry();
    assert.equal(entry.command, "tsx");
    assert.equal(entry.args.length, 1);
    assert.match(entry.args[0]!, /\/opencara-mcp\.ts$/);
  });
});
