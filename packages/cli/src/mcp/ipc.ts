// IPC channel between opencara-mcp (the MCP subprocess that the agent spawns)
// and the CLI device (the long-running `opencara run` process that owns the
// authenticated WebSocket to the orchestrator).
//
// Why an IPC step at all: ACP agents spawn MCP servers themselves per the
// `mcpServers` field in `session/new`. That subprocess does NOT inherit the
// CLI device's WS file descriptor, and we don't want to hand it the device
// auth token via env (visible in `ps`, mentioned in #28's risks). So the
// MCP subprocess connects locally to the CLI device, which already holds
// the WS, and the device fans out tool-calls over its existing transport.
//
// Wire format: newline-delimited JSON over a Unix-domain socket (or Windows
// named pipe — Node's net.Server.listen(path) abstracts both). Each line is
// one ToolCallFrame (mcp → device) or ToolResultFrame (device → mcp);
// `callId` correlates request and response.
//
// Lifecycle: the CLI device starts the server before spawning the agent,
// passes the socket path to opencara-mcp via env, and closes the server
// when the run finishes. Per-run socket paths keep concurrent runs
// isolated.

import { createServer, createConnection, type Server, type Socket } from "node:net";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve as pathResolve } from "node:path";

// ─── Wire frames ────────────────────────────────────────────────────

export interface ToolCallFrame {
  type: "tool-call";
  callId: string;
  kind: string;
  args: Record<string, unknown>;
}

export interface ToolResultFrame {
  type: "tool-result";
  callId: string;
  result: { ok: true } | { ok: false; reason: string };
}

export type IpcFrame = ToolCallFrame | ToolResultFrame;

/**
 * Env var the CLI device sets when it spawns opencara-mcp. The MCP
 * subprocess reads this on startup; absence is a hard error (the binary
 * has no other reason to exist).
 */
export const IPC_SOCKET_ENV = "OPENCARA_MCP_IPC_SOCKET";

/**
 * Convenience: a per-run socket path under the OS temp dir. Long enough
 * for a ulid; on Linux the sun_path limit is 108 bytes which leaves
 * plenty of room for `${tmpdir()}/opencara-mcp-<runId>.sock`.
 */
export function defaultIpcSocketPath(runId: string): string {
  return pathResolve(tmpdir(), `opencara-mcp-${runId}.sock`);
}

// ─── Framing (newline-delimited JSON) ───────────────────────────────

function encode(frame: IpcFrame): string {
  return JSON.stringify(frame) + "\n";
}

interface DecodeResult {
  frames: IpcFrame[];
  malformed: string[];
  buffered: string;
}

function decode(buffered: string, chunk: string): DecodeResult {
  const buf = buffered + chunk;
  const lines = buf.split("\n");
  const remainder = lines.pop() ?? "";
  const frames: IpcFrame[] = [];
  const malformed: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.length === 0) continue;
    try {
      const parsed: unknown = JSON.parse(t);
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "type" in parsed &&
        ((parsed as { type: unknown }).type === "tool-call" ||
          (parsed as { type: unknown }).type === "tool-result")
      ) {
        frames.push(parsed as IpcFrame);
      } else {
        malformed.push(t);
      }
    } catch {
      malformed.push(t);
    }
  }
  return { frames, malformed, buffered: remainder };
}

// ─── Server (CLI device side) ───────────────────────────────────────

export interface IpcServerOptions {
  socketPath: string;
  /**
   * Invoked for every `tool-call` frame the MCP subprocess sends. Return
   * the result the agent should see. Implementations should NOT throw on
   * domain rejection — surface as `{ ok: false }`. Throwing is reserved
   * for transport-level failure (e.g. WS dropped) and gets logged + the
   * MCP subprocess sees a connection close.
   */
  handler: (call: ToolCallFrame) => Promise<ToolResultFrame["result"]>;
  /** Called when the MCP subprocess connects. */
  onConnect?: () => void;
  /** Called when the MCP subprocess disconnects. */
  onDisconnect?: () => void;
}

export class IpcServer {
  private server: Server | null = null;
  private connection: Socket | null = null;

  constructor(private readonly opts: IpcServerOptions) {}

  async start(): Promise<void> {
    // Best-effort cleanup of a stale socket file. EACCES / ENOENT are both
    // fine (the subsequent listen will surface the real problem).
    await unlink(this.opts.socketPath).catch(() => undefined);

    await new Promise<void>((resolve, reject) => {
      const server = createServer((socket) => {
        // Only one MCP client per run. If a second one connects, drop it
        // — the agent shouldn't be spawning multiple opencara-mcp.
        if (this.connection) {
          socket.destroy();
          return;
        }
        this.connection = socket;
        this.opts.onConnect?.();
        let buffered = "";
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => {
          const d = decode(buffered, chunk);
          buffered = d.buffered;
          for (const frame of d.frames) {
            if (frame.type === "tool-call") {
              void this.handleCall(frame, socket);
            }
            // tool-result frames go server→client only; ignore from client.
          }
        });
        socket.on("close", () => {
          if (this.connection === socket) this.connection = null;
          this.opts.onDisconnect?.();
        });
        socket.on("error", () => {
          // Connection errors close the socket; nothing to do here.
        });
      });
      server.on("error", reject);
      server.listen(this.opts.socketPath, () => {
        this.server = server;
        resolve();
      });
    });
  }

  private async handleCall(call: ToolCallFrame, socket: Socket): Promise<void> {
    let result: ToolResultFrame["result"];
    try {
      result = await this.opts.handler(call);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      result = { ok: false, reason: `transport error: ${reason}` };
    }
    if (socket.writable) {
      socket.write(encode({ type: "tool-result", callId: call.callId, result }));
    }
  }

  async stop(): Promise<void> {
    if (this.connection) {
      this.connection.destroy();
      this.connection = null;
    }
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    await unlink(this.opts.socketPath).catch(() => undefined);
  }
}

// ─── Client (opencara-mcp side) ─────────────────────────────────────

export class IpcClient {
  private socket: Socket | null = null;
  private buffered = "";
  private nextCallId = 1;
  private readonly pending = new Map<
    string,
    { resolve: (r: ToolResultFrame["result"]) => void; reject: (e: Error) => void }
  >();

  constructor(private readonly socketPath: string) {}

  async connect(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath }, () => {
        this.socket = socket;
        socket.setEncoding("utf8");
        socket.on("data", (chunk: string) => this.onData(chunk));
        socket.on("close", () => this.onClose("socket closed"));
        socket.on("error", (err) => this.onClose(`socket error: ${err.message}`));
        resolve();
      });
      socket.once("error", (err) => {
        // If we never connected, surface the error to the caller.
        if (!this.socket) reject(err);
      });
    });
  }

  /** Mint a callId and round-trip a tool-call. */
  async call(kind: string, args: Record<string, unknown>): Promise<ToolResultFrame["result"]> {
    if (!this.socket) throw new Error("ipc client not connected");
    const callId = `c${this.nextCallId++}`;
    const frame: ToolCallFrame = { type: "tool-call", callId, kind, args };
    return new Promise<ToolResultFrame["result"]>((resolve, reject) => {
      this.pending.set(callId, { resolve, reject });
      this.socket!.write(encode(frame));
    });
  }

  close(): void {
    this.onClose("close()");
    if (this.socket) {
      this.socket.end();
      this.socket = null;
    }
  }

  private onData(chunk: string): void {
    const d = decode(this.buffered, chunk);
    this.buffered = d.buffered;
    for (const frame of d.frames) {
      if (frame.type === "tool-result") {
        const p = this.pending.get(frame.callId);
        if (p) {
          this.pending.delete(frame.callId);
          p.resolve(frame.result);
        }
      }
      // tool-call frames go client→server only; ignore from server.
    }
  }

  private onClose(reason: string): void {
    if (this.pending.size === 0) return;
    const err = new Error(`ipc client disconnected: ${reason}`);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }
}
