import { ulid } from "ulid";
import type { WSContext } from "hono/ws";
import { eq } from "drizzle-orm";
import {
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
  applyTemplateNodeConfigSet,
  type AgentCallResult,
} from "../agent-calls/index.js";

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
}

export class DevicePool {
  private devices = new Map<string, ConnectedDevice>();
  private pending = new Map<string, PendingJob>();
  private db: Db;

  constructor(db: Db) {
    this.db = db;
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
      const exitCode = msg.exitCode ?? (msg.status === "succeeded" ? 0 : 1);
      p.resolve({
        exitCode,
        stdoutCaptured: p.stdoutCaptured.join(""),
      });
      return;
    }
    if (msg.type === "agent-call") {
      // Fire-and-forget. The CLI parsed an opencara-call fenced block and
      // proxied it here using its device-level WS auth. We gate on:
      //   1. The runId belongs to a pending dispatch we issued.
      //   2. The dispatch went to THIS device (cross-check agentHostId).
      // The per-kind helpers in `applyAgentCall` enforce their own scope
      // requirements (projectId for issue/flow, userId for template) —
      // we do NOT broad-gate on projectId here, because template edits
      // come from `/flows/:slug` which is user-scoped, not project-scoped.
      // Anything else is a silent ignore — same shape as log/done miss.
      const p = this.pending.get(msg.runId);
      if (!p) return;
      if (p.agentHostId !== agentHostId) {
        console.warn("[device-pool] agent-call hostId mismatch", {
          runId: msg.runId,
          expected: p.agentHostId,
          got: agentHostId,
        });
        return;
      }
      void this.applyAgentCall(p.projectId, p.userId, msg).catch((err) => {
        console.error("[device-pool] agent-call apply failed", {
          runId: msg.runId,
          callId: msg.callId,
          kind: msg.kind,
          err,
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
  private async applyAgentCall(
    projectId: string | null,
    userId: string | null,
    msg: Extract<DeviceToServerMessage, { type: "agent-call" }>,
  ): Promise<void> {
    let result: AgentCallResult;
    switch (msg.kind) {
      case "issue.body.set":
        if (!projectId) {
          result = {
            ok: false,
            reason: "issue mutations require a project-scoped run",
          };
          break;
        }
        result = await applyIssueBodySet(this.db, projectId, msg);
        break;
      case "flow.node.config.set":
        if (!projectId) {
          result = {
            ok: false,
            reason: "flow mutations require a project-scoped run",
          };
          break;
        }
        result = await applyFlowNodeConfigSet(this.db, projectId, msg);
        break;
      case "template.node.config.set":
        if (!userId) {
          result = {
            ok: false,
            reason: "template mutations require a user-scoped run",
          };
          break;
        }
        result = await applyTemplateNodeConfigSet(this.db, userId, msg);
        break;
      default: {
        // Discriminated union: TS ensures exhaustiveness when more kinds arrive.
        const exhaustive: never = msg;
        void exhaustive;
        return;
      }
    }
    if (!result.ok) {
      console.warn("[device-pool] agent-call rejected", {
        runId: msg.runId,
        callId: msg.callId,
        kind: msg.kind,
        reason: result.reason,
      });
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
      });
    });
  }
}

export class WebSocketDispatcher implements AgentDispatcher {
  constructor(private pool: DevicePool) {}

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

    const run: AgentRun = {
      id: ulid(),
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
    );
    this.pool.send(dev, { type: "job", run, spec, stdinJson: ctx.stdinJson });
    return promise;
  }
}
