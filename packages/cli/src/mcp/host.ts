// Per-run MCP host: bundles the IPC server with the metadata the agent's
// ACP `session/new` needs to spawn opencara-mcp as a subprocess.
//
// Lifecycle (from the CLI device's perspective):
//   1. Job arrives. Build an `McpHost` with the run's id and a
//      `ToolCallRouter` (production: forwards to the orchestrator over
//      the device WS; spike: a stub).
//   2. `await host.start()` — IPC server starts listening at a per-run
//      socket path under the OS tmp dir.
//   3. `host.acpServerEntry()` returns the object to put in ACP
//      `session/new`'s `mcpServers` array. The agent then spawns
//      opencara-mcp itself, and opencara-mcp dials back to the IPC
//      socket via the env var.
//   4. Tool calls fan out: agent → opencara-mcp → IPC → router → result
//      → IPC → opencara-mcp → agent.
//   5. `await host.stop()` when the run ends. Removes the socket file.
//
// This module deliberately doesn't talk to the WS or know about runJob —
// that wiring lives one level up in #29. Here it's a small, testable
// orchestrator.

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve as pathResolve } from "node:path";
import { IpcServer, IPC_SOCKET_ENV, defaultIpcSocketPath } from "./ipc.js";
import type { ToolCallRouter } from "./tools.js";

export interface McpHostOptions {
  runId: string;
  router: ToolCallRouter;
  /**
   * Override the socket path. Defaults to `${tmpdir()}/opencara-mcp-<runId>.sock`.
   */
  socketPath?: string;
  /**
   * How to launch opencara-mcp itself. Defaults are dev-friendly
   * (`tsx <abs path to opencara-mcp.ts>`) so the spike harness works
   * out of the box. When the bundle ships in prod (#29 / #30), the
   * caller passes the resolved binary path instead.
   */
  mcpCommand?: string;
  mcpArgs?: string[];
}

/**
 * Default invocation. Three layouts to handle:
 *
 *   1. Source dev (`pnpm --filter opencara dev` / spike scripts).
 *      `import.meta.url` resolves to packages/cli/src/mcp/host.ts;
 *      the source bin lives at ../bin/opencara-mcp.ts. Run via tsx.
 *
 *   2. Bundled / installed (`npm i -g opencara`). esbuild collapses
 *      everything into dist/bin.js; opencara-mcp ships as a sibling
 *      dist/opencara-mcp.js with its own shebang. Run via node.
 *
 *   3. Last resort: rely on `opencara-mcp` being on PATH (npm sets up
 *      the bin shim during install). Used if neither file exists at
 *      the resolved location — shouldn't happen but keeps us out of
 *      "throws at session start" territory.
 */
function defaultMcpInvocation(): { command: string; args: string[] } {
  const here = dirname(fileURLToPath(import.meta.url));
  const sourceBin = pathResolve(here, "..", "bin", "opencara-mcp.ts");
  if (existsSync(sourceBin)) {
    return { command: "tsx", args: [sourceBin] };
  }
  const distBin = pathResolve(here, "opencara-mcp.js");
  if (existsSync(distBin)) {
    return { command: "node", args: [distBin] };
  }
  return { command: "opencara-mcp", args: [] };
}

export class McpHost {
  private readonly server: IpcServer;
  private readonly socketPath: string;
  private readonly mcpCommand: string;
  private readonly mcpArgs: string[];
  private started = false;

  constructor(opts: McpHostOptions) {
    this.socketPath = opts.socketPath ?? defaultIpcSocketPath(opts.runId);
    const inv = opts.mcpCommand
      ? { command: opts.mcpCommand, args: opts.mcpArgs ?? [] }
      : defaultMcpInvocation();
    this.mcpCommand = inv.command;
    this.mcpArgs = inv.args;
    this.server = new IpcServer({
      socketPath: this.socketPath,
      handler: async (call) => {
        // Forward to the injected router (WS bridge in prod, stub in
        // tests). Domain rejections come back as `{ ok: false }`;
        // transport-level failures throw out of router.call and the IPC
        // server reports them as `{ ok: false, reason: "transport
        // error: …" }` to opencara-mcp.
        return opts.router.call(call.kind, call.args);
      },
    });
  }

  async start(): Promise<void> {
    if (this.started) return;
    await this.server.start();
    this.started = true;
  }

  /**
   * The shape the ACP client should put in `session/new`'s `mcpServers`
   * array. Agent spawns this command; opencara-mcp reads
   * `OPENCARA_MCP_IPC_SOCKET` and dials back to our IPC server.
   */
  acpServerEntry(): {
    type: "stdio";
    name: string;
    command: string;
    args: string[];
    env: Array<{ name: string; value: string }>;
  } {
    return {
      type: "stdio",
      name: "opencara",
      command: this.mcpCommand,
      args: [...this.mcpArgs],
      env: [{ name: IPC_SOCKET_ENV, value: this.socketPath }],
    };
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.server.stop();
    this.started = false;
  }
}
