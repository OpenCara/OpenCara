import { ulid } from "ulid";
import type { WSContext } from "hono/ws";
import { eq } from "drizzle-orm";
import {
  type AgentCall,
  type AgentCallRequest,
  type AgentRun,
  type AgentSpec,
  type DeviceToServerMessage,
  type ServerToDeviceMessage,
} from "@opencara/shared";
import type { Db } from "../db/client.js";
import { agentHosts } from "../db/schema.js";
import type { AgentDispatcher, RunContext, RunResult } from "./dispatcher.js";
import {
  applyFlowNodeConfigSet,
  applyIssueBodySet,
  applyKanbanWaveDispatch,
  applyTemplateNodeConfigSet,
  type AgentCallResult,
} from "../agent-calls/index.js";
import type { FlowEngine } from "../flows/engine.js";
import type { GithubAppClient } from "../github/app.js";

export interface ConnectedDevice {
  agentHostId: string;
  /**
   * Per-connection identity, minted once per WebSocket in the WS endpoint's
   * onOpen. The pool keys its map by agentHostId (one live socket per host),
   * but a flaky link can leave a *stale* socket whose `close` arrives only
   * AFTER the device has already reconnected with a fresh socket. Without a
   * connection identity, that late close would `delete(agentHostId)` and
   * evict the live reconnection — the device then looks disconnected while
   * the client believes it is online (chat dispatch throws "pinned device …
   * is not connected"). Every mutation that can race a reconnect is therefore
   * gated on connId so a stale socket only ever tears down itself.
   */
  connId: string;
  userId: string | null;
  ws: WSContext<unknown>;
  /**
   * Liveness flag for the server-side heartbeat sweep. Set true on register
   * and on every pong; the sweep flips it false before each ping and reaps
   * the socket if it is still false on the next tick (missed a full round —
   * a half-open connection the TCP stack hasn't noticed yet).
   */
  isAlive: boolean;
  /**
   * RunIds currently dispatched to this device but not yet acked with `done`.
   * The CLI's onMessage hands each job off via `void executeJob(...)` so the
   * remote can run multiple in parallel — the orchestrator just has to stop
   * artificially gating on "one job at a time".
   */
  inflight: Set<string>;
}

/**
 * The subset of the underlying `ws` WebSocket (exposed as WSContext.raw by
 * @hono/node-ws) the heartbeat needs. Kept minimal so the pool doesn't take a
 * hard dependency on the `ws` types and stays trivially fakeable in tests.
 */
interface RawSocket {
  readyState: number;
  ping(): void;
  terminate(): void;
  on(event: "pong", listener: () => void): void;
}

interface PendingJob {
  resolve: (r: RunResult) => void;
  reject: (e: Error) => void;
  onLog: RunContext["onLog"];
  stdoutCaptured: string[];
  agentHostId: string;
  /**
   * The connId of the socket this job was dispatched to. A reconnect mints a
   * new connId, so when an old socket finally closes we reject only the jobs
   * that were actually running on *it* — jobs dispatched to the fresh socket
   * survive the stale close.
   */
  connId: string;
  /**
   * Project scope for agent-call validation. The CLI proxies callbacks
   * over WS using its device token; when an `agent-call` arrives, the
   * orchestrator gates the mutation to resources in this project. Null
   * means "this run isn't allowed to make agent-calls" (legacy paths
   * without canvas context).
   */
  projectId: string | null;
  /**
   * Owning user. Per-user resources (template drafts, prompts) key on
   * this; agent-calls touching those resources require a non-null value.
   */
  userId: string | null;
  /**
   * Chat session id. Threaded into pm_waves.thread_key so the PM panel
   * can surface active waves from its own conversation thread.
   */
  sessionId: string | null;
}

export class DevicePool {
  private devices = new Map<string, ConnectedDevice>();
  private pending = new Map<string, PendingJob>();
  private db: Db;
  private flowEngine: FlowEngine | null;
  private githubApp: GithubAppClient | null;

  constructor(db: Db) {
    this.db = db;
    this.flowEngine = null;
    this.githubApp = null;
  }

  /** Wire in the flow engine after construction (avoids circular dependency). */
  setFlowEngine(engine: FlowEngine): void {
    this.flowEngine = engine;
  }

  /** Wire in the GitHub App client after construction. */
  setGithubApp(app: GithubAppClient): void {
    this.githubApp = app;
  }

  register(d: ConnectedDevice): void {
    d.isAlive = true;
    // Mark live on every pong so the heartbeat sweep doesn't reap a healthy
    // socket. Registering the listener here (rather than in startHeartbeat)
    // keeps it tied to the socket's lifetime and is harmless when the sweep
    // is disabled (e.g. in unit tests).
    const raw = d.ws.raw as RawSocket | undefined;
    raw?.on("pong", () => {
      d.isAlive = true;
    });

    // Supersede any existing socket for this host. On a flaky link the client
    // reconnects (this new socket) before the old socket's close propagates;
    // proactively closing the old one stops it lingering as a half-open leak
    // and turns its eventual onClose into a connId-mismatched no-op below.
    const existing = this.devices.get(d.agentHostId);
    if (existing && existing.connId !== d.connId) {
      try {
        existing.ws.close(4000, "superseded");
      } catch {
        // best-effort; the old socket may already be closing.
      }
    }

    this.devices.set(d.agentHostId, d);
    void this.db
      .update(agentHosts)
      .set({ lastConnectedAt: new Date() })
      .where(eq(agentHosts.id, d.agentHostId));
  }

  /**
   * Tear down a socket. `connId` scopes the teardown to a specific connection
   * so a stale socket's late close can't evict a live reconnection:
   *  - the device entry is deleted only if the *currently registered* socket
   *    is the one closing (connId matches);
   *  - pending jobs are rejected only if they were dispatched to that socket.
   * Omitting connId purges the host outright (revoke path), rejecting all of
   * its pending jobs regardless of connection.
   */
  unregister(agentHostId: string, connId?: string): void {
    const current = this.devices.get(agentHostId);
    if (connId === undefined || current?.connId === connId) {
      this.devices.delete(agentHostId);
    }
    // Reject pending jobs that ran on this connection (or all of the host's
    // jobs when no connId is given).
    for (const [runId, p] of this.pending) {
      if (p.agentHostId !== agentHostId) continue;
      if (connId !== undefined && p.connId !== connId) continue;
      p.reject(new Error(`device ${agentHostId} disconnected`));
      this.pending.delete(runId);
    }
  }

  /**
   * Forcibly close any open WS for this device + unregister from the pool.
   * Used when the device is being deleted server-side (revoke) so the remote
   * `opencara run` process notices the kick instead of hanging onto a now-
   * orphaned auth token.
   */
  disconnect(agentHostId: string, code = 4001, reason = "revoked"): void {
    const dev = this.devices.get(agentHostId);
    if (dev) {
      try {
        dev.ws.close(code, reason);
      } catch {
        // best-effort; the WS may already be in a closing state
      }
    }
    // Purge the whole host (no connId): revoke must drop every connection and
    // fail every in-flight job, not just the currently-registered socket.
    this.unregister(agentHostId);
  }

  /**
   * Start a server-side heartbeat. Each tick pings every connected device and
   * reaps any socket that missed the previous round's pong — a half-open
   * connection the local TCP stack hasn't surfaced yet. The CLI also pings
   * from its side, but only the server reap promptly evicts a silently-dead
   * socket from the pool (otherwise it lingers until TCP keepalive, ~2h, and
   * pinned dispatch keeps targeting a dead connection). Returns the timer so
   * the caller can `.unref()` it; safe to leave unstarted in tests.
   */
  startHeartbeat(intervalMs = 30_000): NodeJS.Timeout {
    return setInterval(() => this.heartbeatSweep(), intervalMs);
  }

  /**
   * One heartbeat round (extracted from the interval so it can be driven
   * deterministically in tests): reap sockets that missed the previous
   * round's pong, then ping the rest and arm them for the next round.
   */
  heartbeatSweep(): void {
    for (const dev of this.devices.values()) {
      const raw = dev.ws.raw as RawSocket | undefined;
      if (!raw) continue;
      if (!dev.isAlive) {
        // Missed a full ping/pong round — force the socket closed. The
        // resulting onClose runs connId-scoped unregister, so this can't
        // evict a newer reconnection.
        try {
          raw.terminate();
        } catch {
          // best-effort
        }
        continue;
      }
      dev.isAlive = false;
      try {
        raw.ping();
      } catch {
        // best-effort; a send failure will surface as a close next tick.
      }
    }
  }

  /**
   * Pick a device for an unpinned job. Prefers truly idle devices (no
   * inflight jobs) for fan-out across the fleet, but falls back to the
   * least-loaded connected device so a single-device install still gets
   * concurrent execution instead of "no idle device available".
   */
  pickIdle(): ConnectedDevice | null {
    let best: ConnectedDevice | null = null;
    for (const d of this.devices.values()) {
      if (d.inflight.size === 0) return d;
      if (!best || d.inflight.size < best.inflight.size) best = d;
    }
    return best;
  }

  /**
   * Look up a specific device by id. Returns null if not connected; the
   * caller decides whether to fall back to pickIdle() or fail. The
   * dispatcher fails fast on a missing pinned host because pinning is an
   * explicit operator choice, not a hint.
   */
  byId(agentHostId: string): ConnectedDevice | null {
    return this.devices.get(agentHostId) ?? null;
  }

  hasAnyConnected(): boolean {
    return this.devices.size > 0;
  }

  isConnected(agentHostId: string): boolean {
    return this.devices.has(agentHostId);
  }

  handleMessage(agentHostId: string, msg: DeviceToServerMessage): void {
    if (msg.type === "log") {
      const p = this.pending.get(msg.runId);
      if (!p) return;
      p.onLog(msg.stream, msg.chunk);
      if (msg.stream === "stdout") p.stdoutCaptured.push(msg.chunk);
      return;
    }
    if (msg.type === "done") {
      const p = this.pending.get(msg.runId);
      if (!p) return;
      const dev = this.devices.get(p.agentHostId);
      if (dev) dev.inflight.delete(msg.runId);
      this.pending.delete(msg.runId);
      // Surface device-side failures (spawn errors, unhandled throws
      // inside runAcpJob, etc.) as a synthetic stderr line so they
      // land in agent_run_logs alongside real agent output. Without
      // this, a `done` carrying `errorMessage` resolves the run with
      // exit_code=1 and zero log rows — operators only see the generic
      // "agent exited with code 1" with nothing to follow.
      if (msg.errorMessage && msg.status !== "succeeded") {
        const line = msg.errorMessage.endsWith("\n")
          ? `[device] ${msg.errorMessage}`
          : `[device] ${msg.errorMessage}\n`;
        p.onLog("stderr", line);
      }
      const exitCode = msg.exitCode ?? (msg.status === "succeeded" ? 0 : 1);
      p.resolve({
        exitCode,
        stdoutCaptured: p.stdoutCaptured.join(""),
        agentHostId: p.agentHostId,
        acpSessionId: msg.acpSessionId ?? null,
      });
      return;
    }
    if (msg.type === "agent-call-request") {
      // Request/response path used by the ACP/MCP cutover. Same scope
      // checks and apply helpers as the legacy `agent-call`, but we send
      // an `agent-call-result` back over the WS so the CLI device can
      // forward it (via IPC) to opencara-mcp, which returns it as the
      // tool result to the agent.
      const p = this.pending.get(msg.runId);
      if (!p) {
        // No pending dispatch — likely a late frame after the run ended.
        // Drop silently; no one is listening for the result.
        return;
      }
      if (p.agentHostId !== agentHostId) {
        console.warn("[device-pool] agent-call-request hostId mismatch", {
          runId: msg.runId,
          expected: p.agentHostId,
          got: agentHostId,
        });
        return;
      }
      const dev = this.devices.get(agentHostId);
      void this.applyAgentCall(p.projectId, p.userId, p.sessionId, msg)
        .then((result) => {
          if (!dev) return; // device disconnected mid-call.
          this.send(dev, {
            type: "agent-call-result",
            runId: msg.runId,
            callId: msg.callId,
            result,
          });
          if (!result.ok) {
            console.warn("[device-pool] agent-call-request rejected", {
              runId: msg.runId,
              callId: msg.callId,
              kind: msg.kind,
              reason: result.reason,
            });
          }
        })
        .catch((err) => {
          console.error("[device-pool] agent-call-request apply failed", {
            runId: msg.runId,
            callId: msg.callId,
            kind: msg.kind,
            err,
          });
          if (!dev) return;
          const reason = err instanceof Error ? err.message : String(err);
          this.send(dev, {
            type: "agent-call-result",
            runId: msg.runId,
            callId: msg.callId,
            result: { ok: false, reason: `internal error: ${reason}` },
          });
        });
      return;
    }
    // hello / pong handled inline by the WS endpoint
  }

  // Routes an authenticated, scope-validated agent-call to its handler in
  // ../agent-calls/. New kinds are additions to this switch + a new helper
  // file; the discriminated union forces exhaustiveness at compile time.
  // Each handler enforces its own scope: project-scoped kinds reject
  // when projectId is null; user-scoped kinds reject when userId is null.
  //
  // Accepts either the legacy `AgentCall` or the new `AgentCallRequest`
  // — they share all kind-specific fields and only differ in the `type`
  // discriminator the helper doesn't read.
  private async applyAgentCall(
    projectId: string | null,
    userId: string | null,
    sessionId: string | null,
    msg: AgentCall | AgentCallRequest,
  ): Promise<AgentCallResult> {
    switch (msg.kind) {
      case "issue.body.set":
        if (!projectId) {
          return {
            ok: false,
            reason: "issue mutations require a project-scoped run",
          };
        }
        return applyIssueBodySet(this.db, projectId, msg);
      case "flow.node.config.set":
        if (!projectId) {
          return {
            ok: false,
            reason: "flow mutations require a project-scoped run",
          };
        }
        return applyFlowNodeConfigSet(this.db, projectId, msg);
      case "template.node.config.set":
        if (!userId) {
          return {
            ok: false,
            reason: "template mutations require a user-scoped run",
          };
        }
        return applyTemplateNodeConfigSet(this.db, userId, msg);
      case "kanban.wave.dispatch": {
        if (!projectId) {
          return {
            ok: false,
            reason: "kanban.wave.dispatch requires a project-scoped run",
          };
        }
        if (!this.flowEngine) {
          return { ok: false, reason: "flow engine not available" };
        }
        return applyKanbanWaveDispatch(
          this.db,
          projectId,
          this.flowEngine,
          sessionId ?? msg.runId,
          msg,
        );
      }
      default: {
        // Discriminated union: TS ensures exhaustiveness when more kinds arrive.
        const exhaustive: never = msg;
        void exhaustive;
        return { ok: false, reason: "unknown kind" };
      }
    }
  }

  send(d: ConnectedDevice, msg: ServerToDeviceMessage): void {
    try {
      d.ws.send(JSON.stringify(msg));
    } catch (err) {
      console.error("[device-pool] send failed", err);
    }
  }

  awaitJob(
    runId: string,
    agentHostId: string,
    connId: string,
    onLog: RunContext["onLog"],
    projectId: string | null,
    userId: string | null,
    sessionId: string | null,
  ): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      this.pending.set(runId, {
        resolve,
        reject,
        onLog,
        stdoutCaptured: [],
        agentHostId,
        connId,
        projectId,
        userId,
        sessionId,
      });
    });
  }

  /**
   * The host currently running `runId`, or null if the run is not in
   * the pending map. Used by the cancel path so callers don't have to
   * thread the hostId via the DB (where it's set only by the `done`
   * handler — a cancel arriving before `done` would otherwise have to
   * either guess or no-op).
   */
  hostForRun(runId: string): string | null {
    return this.pending.get(runId)?.agentHostId ?? null;
  }

  /**
   * Reject a still-pending job (deadline path). Mirrors the `done`
   * handler's cleanup so the device's inflight set and the pending map
   * stay consistent, and emits a synthetic stderr line so the timeout is
   * visible in agent_run_logs instead of only in the step error. Returns
   * false when the run already settled — a lost race is a no-op.
   */
  expireJob(runId: string, message: string): boolean {
    const p = this.pending.get(runId);
    if (!p) return false;
    const dev = this.devices.get(p.agentHostId);
    if (dev) dev.inflight.delete(runId);
    this.pending.delete(runId);
    p.onLog("stderr", `[orchestrator] ${message}\n`);
    p.reject(new Error(message));
    return true;
  }
}

export class WebSocketDispatcher implements AgentDispatcher {
  /**
   * @param defaultJobTimeoutMs wall-clock ceiling applied to every run
   * unless the caller overrides via `ctx.timeoutMs`. 0/undefined disables
   * the default (callers can still set a per-run deadline).
   */
  constructor(
    private pool: DevicePool,
    private defaultJobTimeoutMs?: number,
  ) {}

  isConnected(hostId: string): boolean {
    return this.pool.isConnected(hostId);
  }

  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    let dev: ConnectedDevice | null;
    if (ctx.hostId) {
      // Pinned: must be that exact host. The CLI runs jobs concurrently, so
      // we don't gate on "already running something" — operators who pin
      // multiple agents to the same device expect them to run in parallel
      // (e.g. a multi-reviewer flow with one device).
      //
      // Capacity caveat: there is currently NO per-device concurrency cap.
      // A burst of N parallel jobs is the operator's responsibility — pick
      // a host with enough RAM/CPU before pinning many reviewers to it.
      // If this becomes a footgun in practice, add a `max_concurrent`
      // column on agent_hosts and gate `inflight.size` against it.
      dev = this.pool.byId(ctx.hostId);
      if (!dev) throw new Error(`pinned device ${ctx.hostId} is not connected`);
    } else {
      dev = this.pool.pickIdle();
      if (!dev) throw new Error("no device connected");
    }

    // Prefer caller-supplied runId so chat / agent-test / worktree-cleanup
    // can keep the WS-frame id, the DB id, the log table id, and any
    // future cancel target all in lockstep. Callers that don't care still
    // get the prior auto-ulid behaviour.
    const runId = ctx.runId ?? ulid();
    const run: AgentRun = {
      id: runId,
      spec,
      status: "assigned",
      hostId: dev.agentHostId,
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      exitCode: null,
    };
    dev.inflight.add(run.id);

    const promise = this.pool.awaitJob(
      run.id,
      dev.agentHostId,
      dev.connId,
      ctx.onLog,
      ctx.projectId ?? null,
      ctx.userId ?? null,
      ctx.sessionId ?? null,
    );
    this.pool.send(dev, { type: "job", run, spec, stdinJson: ctx.stdinJson });

    // Per-job wall-clock deadline. Without one, a wedged agent on a healthy
    // socket parks the pending entry — and its flow run — as "running"
    // forever; the boot reaper (orchestrator restart) was the only recovery.
    const timeoutMs = ctx.timeoutMs ?? this.defaultJobTimeoutMs ?? 0;
    if (timeoutMs <= 0) return promise;
    const timer = setTimeout(() => {
      // Order matters: cancel() resolves the device via the pending map,
      // so signal the process before expireJob() removes the entry.
      //
      // Wire reason is "user_stopped" (not a dedicated "timeout") because
      // CancelJobSchema's enum is closed and already-published CLIs drop
      // frames that fail strict parse — a new enum value would make old
      // devices ignore the kill entirely. Revisit when the protocol grows
      // a version handshake.
      this.cancel(runId, "user_stopped");
      this.pool.expireJob(
        runId,
        `agent run ${runId} exceeded the ${Math.round(timeoutMs / 1000)}s job timeout and was cancelled`,
      );
    }, timeoutMs);
    // No .unref(): the timer is cleared whenever the promise settles, and
    // socket teardown (unregister) settles every pending job — so this
    // can't hold a shutting-down process open, but unref'ing it WOULD let
    // an otherwise-idle event loop exit before the deadline fires.
    return promise.finally(() => clearTimeout(timer));
  }

  cancel(
    runId: string,
    reason: "user_stopped" | "wave_cancelled",
  ): boolean {
    // Resolve the device from the in-memory pending map rather than
    // the DB. `agent_runs.host_id` is written by the device pool's
    // `done` handler (i.e. only after the run finishes), so a cancel
    // arriving while the run is still in flight would always read
    // NULL there. The pending map IS the in-flight state.
    const hostId = this.pool.hostForRun(runId);
    if (!hostId) return false;
    const dev = this.pool.byId(hostId);
    if (!dev) return false;
    // Best-effort: the device may have already moved past the cancellable
    // window (e.g. the agent's prompt() resolved and we're about to send
    // `done`). The orchestrator's pending-map lookup on the eventual
    // `done` frame stays valid regardless, so a late cancel that misses
    // is harmless. The DB-side status flip happens in the caller.
    this.pool.send(dev, { type: "cancel", runId, reason });
    return true;
  }
}
