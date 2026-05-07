// AcpClient — drive an ACP-speaking agent process from the client side.
//
// This module owns:
//   1. Child-process lifecycle (spawn, stdio piping, exit signal).
//   2. JSON-RPC framing on stdin/stdout via FrameDecoder + encodeFrame.
//   3. Request-id correlation: every outbound request gets a numeric id and a
//      pending-promise entry; the matching inbound response resolves/rejects.
//   4. Inbound dispatch: responses → correlation table; session/update
//      notifications → sessionUpdate listener; any other agent→client
//      request → method-not-found error (we advertise no client capabilities
//      in this spike).
//
// What it deliberately does NOT do:
//   - No retry, no reconnect, no timeouts. The spike is a one-shot.
//   - No Zod validation. Schema authority lives upstream
//     (zed-industries/agent-client-protocol).
//   - No higher-level skill / page-context shaping. That's the chat route's
//     job in #29.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { encodeFrame, FrameDecoder } from "./framing.js";
import {
  JSON_RPC_ERROR_METHOD_NOT_FOUND,
  type JsonRpcId,
  type JsonRpcMessage,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "./jsonrpc.js";
import {
  ACP_METHODS,
  ACP_PROTOCOL_VERSION,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionNotificationParams,
} from "./types.js";

export interface AcpClientOptions {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  /**
   * If true, every inbound and outbound JSON-RPC frame is emitted on the
   * `frame` listener. The spike harness uses this to dump the raw wire to
   * disk; production code leaves it off.
   */
  trace?: boolean;
}

export interface AcpExitInfo {
  code: number | null;
  signal: NodeJS.Signals | null;
}

/**
 * Direction tag for traced frames. `out` = client → agent (we wrote it),
 * `in` = agent → client (we read it).
 */
export type TraceDirection = "in" | "out";

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (err: Error) => void;
  method: string;
}

/**
 * Subset of the JSON-RPC stream.Writable surface we need. Pulled out as a
 * type rather than imported so the unit tests can drive this with an
 * in-memory pair without wiring real pipes.
 */
interface WritableLike {
  write(chunk: string): void;
}

/**
 * Internal entrypoint shared by the public `AcpClient` (which wraps a real
 * child process) and the tests (which inject a fake transport). All routing
 * and correlation logic lives here.
 */
export class AcpConnection {
  private readonly decoder = new FrameDecoder();
  private readonly pending = new Map<JsonRpcId, PendingRequest>();
  private readonly emitter = new EventEmitter();
  private nextId = 1;
  private closed = false;

  constructor(
    private readonly out: WritableLike,
    private readonly trace: boolean,
  ) {}

  // ─── public events ───────────────────────────────────────────────

  onSessionUpdate(fn: (params: SessionNotificationParams) => void): void {
    this.emitter.on("sessionUpdate", fn);
  }

  /** Called for EVERY frame that crosses the wire — both directions. */
  onFrame(fn: (direction: TraceDirection, msg: JsonRpcMessage) => void): void {
    this.emitter.on("frame", fn);
  }

  /** Malformed lines (parse errors). The spike harness logs these. */
  onMalformed(fn: (line: string) => void): void {
    this.emitter.on("malformed", fn);
  }

  // ─── public methods ──────────────────────────────────────────────

  initialize(req: InitializeRequest): Promise<InitializeResponse> {
    return this.request(ACP_METHODS.initialize, req) as Promise<InitializeResponse>;
  }

  newSession(req: NewSessionRequest): Promise<NewSessionResponse> {
    return this.request(ACP_METHODS.session_new, req) as Promise<NewSessionResponse>;
  }

  prompt(req: PromptRequest): Promise<PromptResponse> {
    return this.request(ACP_METHODS.session_prompt, req) as Promise<PromptResponse>;
  }

  /** Notification (no reply). Used to cancel a turn mid-flight. */
  cancel(sessionId: string): void {
    this.notify(ACP_METHODS.session_cancel, { sessionId });
  }

  // ─── ingest path (public so the wrapper can pump bytes in) ───────

  feed(chunk: string): void {
    if (this.closed) return;
    const { messages, malformed } = this.decoder.feed(chunk);
    for (const line of malformed) this.emitter.emit("malformed", line);
    for (const msg of messages) this.dispatch(msg);
  }

  /**
   * Reject all pending requests. Called when the underlying transport closes
   * (child process exit, stream error, manual disposal). Safe to call twice.
   *
   * User listeners are deliberately NOT cleared. Diagnostic events (frame
   * trace, malformed lines) can still fire during the close sequence, and
   * GC reclaims them when the consumer drops the connection.
   */
  shutdown(reason: string): void {
    if (this.closed) return;
    this.closed = true;
    const err = new Error(`acp connection closed: ${reason}`);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  // ─── internals ───────────────────────────────────────────────────

  private request(method: string, params: unknown): Promise<unknown> {
    if (this.closed) return Promise.reject(new Error("acp connection is closed"));
    const id = this.nextId++;
    const msg: JsonRpcRequest = { jsonrpc: "2.0", id, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.send(msg);
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.closed) return;
    this.send({ jsonrpc: "2.0", method, params });
  }

  private send(msg: JsonRpcMessage): void {
    if (this.trace) this.emitter.emit("frame", "out", msg);
    this.out.write(encodeFrame(msg));
  }

  private dispatch(msg: JsonRpcMessage): void {
    if (this.trace) this.emitter.emit("frame", "in", msg);

    // Property-based narrowing rather than chained type guards: the helpers
    // in jsonrpc.ts are useful at call sites that already hold a narrowed
    // type, but TS doesn't reliably reduce the union through three sequential
    // user-defined predicates. Inline checks keep the narrowing local and
    // unambiguous.
    if ("result" in msg || "error" in msg) {
      // Response. id may be null when the agent couldn't correlate (e.g.
      // parse error on the request). We can't resolve a pending entry then.
      if (msg.id == null) return;
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if ("error" in msg) {
        pending.reject(
          new Error(`${pending.method}: ${msg.error.message} (${msg.error.code})`),
        );
      } else {
        pending.resolve(msg.result);
      }
      return;
    }

    if (!("id" in msg) || msg.id == null) {
      // Notification (no id), or a request-shaped frame with null id. The
      // JSON-RPC spec forbids null id on requests, and replying with id:null
      // helps no one — treat both cases as fire-and-forget. Notification
      // dispatch still applies if the method is known.
      if ("method" in msg && msg.method === ACP_METHODS.session_update) {
        this.emitter.emit("sessionUpdate", msg.params as SessionNotificationParams);
      }
      return;
    }

    // Request from agent → client. We advertised no client capabilities, so
    // we don't expect any — but a misconfigured agent might call one anyway.
    // Reply method-not-found rather than letting the agent hang.
    const reply: JsonRpcResponse = {
      jsonrpc: "2.0",
      id: msg.id,
      error: {
        code: JSON_RPC_ERROR_METHOD_NOT_FOUND,
        message: `method not implemented in spike client: ${msg.method}`,
      },
    };
    this.send(reply);
  }
}

/**
 * Public wrapper that spawns and owns a child ACP-speaking agent process.
 *
 * Lifecycle:
 *   1. `new AcpClient({ command, args, env, cwd })`
 *   2. `start()` — spawns the child. Idempotent.
 *   3. `initialize(...)`, `newSession(...)`, `prompt(...)` in any order the
 *      caller needs.
 *   4. `close()` — closes stdin and waits for the child to exit. Rejects
 *      pending requests if the child exits before they resolve.
 */
export class AcpClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private connection: AcpConnection | null = null;
  private exitPromise: Promise<AcpExitInfo> | null = null;
  private readonly stderrListeners = new Set<(chunk: string) => void>();

  // Pre-start listener queues. Registering listeners before `start()` is the
  // natural order in the spike (and any consumer that wants to capture the
  // very first frame). We hold them here and attach to the live connection
  // inside `start()`. Once started, registrations bypass the queue and go
  // straight to the connection.
  private readonly preStartSessionUpdate: Array<(p: SessionNotificationParams) => void> = [];
  private readonly preStartFrame: Array<(d: TraceDirection, m: JsonRpcMessage) => void> = [];
  private readonly preStartMalformed: Array<(l: string) => void> = [];

  constructor(private readonly opts: AcpClientOptions) {}

  start(): void {
    if (this.child) return;
    const env = { ...process.env, ...(this.opts.env ?? {}) };
    const child = spawn(this.opts.command, this.opts.args ?? [], {
      env,
      cwd: this.opts.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    const conn = new AcpConnection(
      { write: (chunk) => child.stdin.write(chunk) },
      this.opts.trace ?? false,
    );

    // Attach buffered listeners BEFORE wiring stdout, so the very first frame
    // the agent sends after spawn is delivered to consumers that registered
    // in the order spike.ts uses (listeners → start).
    for (const fn of this.preStartSessionUpdate) conn.onSessionUpdate(fn);
    for (const fn of this.preStartFrame) conn.onFrame(fn);
    for (const fn of this.preStartMalformed) conn.onMalformed(fn);
    this.preStartSessionUpdate.length = 0;
    this.preStartFrame.length = 0;
    this.preStartMalformed.length = 0;

    child.stdout.on("data", (chunk: string) => conn.feed(chunk));
    child.stderr.on("data", (chunk: string) => {
      for (const fn of this.stderrListeners) fn(chunk);
    });

    this.exitPromise = new Promise<AcpExitInfo>((resolve) => {
      child.on("close", (code, signal) => {
        conn.shutdown(`child exited code=${code} signal=${signal ?? "none"}`);
        resolve({ code, signal });
      });
      child.on("error", (err) => {
        conn.shutdown(`child error: ${err.message}`);
        resolve({ code: null, signal: null });
      });
    });

    this.child = child;
    this.connection = conn;
  }

  // ─── delegations to the connection ───────────────────────────────

  initialize(req: InitializeRequest = { protocolVersion: ACP_PROTOCOL_VERSION }): Promise<InitializeResponse> {
    return this.must().initialize(req);
  }

  newSession(req: NewSessionRequest): Promise<NewSessionResponse> {
    return this.must().newSession(req);
  }

  prompt(req: PromptRequest): Promise<PromptResponse> {
    return this.must().prompt(req);
  }

  cancel(sessionId: string): void {
    this.must().cancel(sessionId);
  }

  onSessionUpdate(fn: (params: SessionNotificationParams) => void): void {
    if (this.connection) this.connection.onSessionUpdate(fn);
    else this.preStartSessionUpdate.push(fn);
  }

  onFrame(fn: (direction: TraceDirection, msg: JsonRpcMessage) => void): void {
    if (this.connection) this.connection.onFrame(fn);
    else this.preStartFrame.push(fn);
  }

  onMalformed(fn: (line: string) => void): void {
    if (this.connection) this.connection.onMalformed(fn);
    else this.preStartMalformed.push(fn);
  }

  onStderr(fn: (chunk: string) => void): void {
    this.stderrListeners.add(fn);
  }

  /**
   * Close stdin and wait for the child to exit. If the child is still
   * running after `graceMs`, send SIGTERM; if it's still alive after
   * `2 * graceMs`, send SIGKILL. Always resolves.
   */
  async close(graceMs = 2000): Promise<AcpExitInfo> {
    const child = this.child;
    if (!child || !this.exitPromise) return { code: null, signal: null };
    try {
      child.stdin.end();
    } catch {
      // stdin already closed; fine.
    }
    const term = setTimeout(() => {
      try {
        child.kill("SIGTERM");
      } catch {
        // already dead; fine.
      }
    }, graceMs);
    const kill = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already dead; fine.
      }
    }, graceMs * 2);
    try {
      return await this.exitPromise;
    } finally {
      clearTimeout(term);
      clearTimeout(kill);
    }
  }

  private must(): AcpConnection {
    if (!this.connection) throw new Error("acp client not started — call start() first");
    return this.connection;
  }
}
