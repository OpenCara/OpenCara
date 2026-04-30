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
    // hello / pong handled inline by the WS endpoint
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
  ): Promise<RunResult> {
    return new Promise<RunResult>((resolve, reject) => {
      this.pending.set(runId, {
        resolve,
        reject,
        onLog,
        stdoutCaptured: [],
        agentHostId,
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

    const promise = this.pool.awaitJob(run.id, dev.agentHostId, ctx.onLog);
    this.pool.send(dev, { type: "job", run, spec, stdinJson: ctx.stdinJson });
    return promise;
  }
}
