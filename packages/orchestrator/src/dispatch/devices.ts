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
  applyIssueSubissueCreate,
  applyKanbanWaveDispatch,
  applyTemplateNodeConfigSet,
  type AgentCallResult,
} from "../agent-calls/index.js";
import type { FlowEngine } from "../flows/engine.js";
import type { GithubAppClient } from "../github/app.js";

export interface ConnectedDevice {
  agentHostId: string;
  userId: string | null;
  ws: WSContext<unknown>;
  /**
   * RunIds currently dispatched to this device but not yet acked with `done`.
   * The CLI's onMessage hands each job off via `void executeJob(...)` so the
   * remote can run multiple in parallel — the orchestrator just has to stop
   * artificially gating on "one job at a time".
   */
  inflight: Set<string>;
}

interface PendingJob {
  resolve: (r: RunResult) => void;
  reject: (e: Error) => void;
  onLog: RunContext["onLog"];
  stdoutCaptured: string[];
  agentHostId: string;
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
    this.devices.set(d.agentHostId, d);
    void this.db
      .update(agentHosts)
      .set({ lastConnectedAt: new Date() })
      .where(eq(agentHosts.id, d.agentHostId));
  }

  unregister(agentHostId: string): void {
    this.devices.delete(agentHostId);
    // Reject any pending jobs assigned to this device.
    for (const [runId, p] of this.pending) {
      if (p.agentHostId === agentHostId) {
        p.reject(new Error(`device ${agentHostId} disconnected`));
        this.pending.delete(runId);
      }
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
    this.unregister(agentHostId);
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
      case "issue.subissue.create": {
        if (!projectId) {
          return {
            ok: false,
            reason: "issue.subissue.create requires a project-scoped run",
          };
        }
        if (!this.githubApp) {
          return { ok: false, reason: "GitHub App not configured" };
        }
        return applyIssueSubissueCreate(this.db, projectId, this.githubApp, msg);
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
}

export class WebSocketDispatcher implements AgentDispatcher {
  constructor(private pool: DevicePool) {}

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
      ctx.onLog,
      ctx.projectId ?? null,
      ctx.userId ?? null,
      ctx.sessionId ?? null,
    );
    this.pool.send(dev, { type: "job", run, spec, stdinJson: ctx.stdinJson });
    return promise;
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
