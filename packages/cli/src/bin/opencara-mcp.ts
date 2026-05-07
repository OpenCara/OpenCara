#!/usr/bin/env node
//
// opencara-mcp: stdio MCP server that exposes opencara's per-page mutations
// as tools to an ACP-driven coding agent.
//
// Lifecycle: spawned as a subprocess by the agent (per ACP `mcpServers`
// config). Speaks MCP on its own stdio. Forwards every tool call to the
// running `opencara run` device process via a Unix socket whose path is
// provided in `OPENCARA_MCP_IPC_SOCKET`. The device proxies the call over
// its existing authenticated WebSocket to the orchestrator and routes the
// result back.
//
// Why no auth secrets in env: per #28 risk, we deliberately don't put the
// device's WS auth token where opencara-mcp can see it. The IPC handoff
// keeps the auth boundary at the device process; opencara-mcp can only
// reach the orchestrator THROUGH the device, gated by file-system perms
// on the socket.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { env, exit, stderr } from "node:process";
import { IpcClient, IPC_SOCKET_ENV } from "../mcp/ipc.js";
import { registerOpencaraTools, type ToolCallRouter } from "../mcp/tools.js";

async function main(): Promise<void> {
  const socketPath = env[IPC_SOCKET_ENV];
  if (!socketPath) {
    stderr.write(
      `[opencara-mcp] missing ${IPC_SOCKET_ENV} env — this binary is meant to be ` +
        `spawned by the opencara CLI device, not run directly.\n`,
    );
    exit(2);
  }

  const ipc = new IpcClient(socketPath);
  try {
    await ipc.connect();
  } catch (err) {
    const e = err instanceof Error ? err.message : String(err);
    stderr.write(`[opencara-mcp] ipc connect failed: ${e}\n`);
    exit(3);
  }

  const router: ToolCallRouter = {
    async call(kind, args) {
      // Domain rejections come back as `{ ok: false, reason }` and are
      // returned to the agent as a tool error. Transport-level failures
      // throw out of `ipc.call`; let those propagate so the SDK reports
      // them as a tool-execution exception.
      return ipc.call(kind, args);
    },
  };

  const server = new McpServer(
    { name: "opencara", version: "0.0.0" },
    { capabilities: { tools: {} } },
  );
  registerOpencaraTools(server, router);

  const transport = new StdioServerTransport();
  await server.connect(transport);

  // Stay alive until stdio closes (the agent drops the MCP server when
  // the session ends). The MCP SDK's transport handles that lifecycle.
}

main().catch((err) => {
  const e = err instanceof Error ? err.stack ?? err.message : String(err);
  stderr.write(`[opencara-mcp] fatal: ${e}\n`);
  exit(1);
});
