import { ulid } from "ulid";
import type { WSContext } from "hono/ws";
import { eq } from "drizzle-orm";
import {
  type AgentRun,
  type AgentSpec,
  type DeviceToServerMessage,
  type ServerToDeviceMessage,
} from "@openkira/shared";
import type { Db } from "../db/client.js";
import { agentHosts } from "../db/schema.js";
import type { AgentDispatcher, RunContext, RunResult } from "./dispatcher.js";

export interface ConnectedDevice {
  agentHostId: string;
  userId: string | null;
  ws: WSContext<unknown>;
  busy: boolean;
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
   * `openkira run` process notices the kick instead of hanging onto a now-
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

  pickIdle(): ConnectedDevice | null {
    for (const d of this.devices.values()) {
      if (!d.busy) return d;
    }
    return null;
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
      if (dev) dev.busy = false;
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
    const dev = this.pool.pickIdle();
    if (!dev) throw new Error("no idle device available");
    dev.busy = true;

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

    const promise = this.pool.awaitJob(run.id, dev.agentHostId, ctx.onLog);
    this.pool.send(dev, { type: "job", run, spec, stdinJson: ctx.stdinJson });
    return promise;
  }
}
