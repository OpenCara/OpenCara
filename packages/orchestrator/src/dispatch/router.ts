import type { AgentSpec } from "@opencara/shared";
import type { AgentDispatcher, RunContext, RunResult } from "./dispatcher.js";
import type { LocalSubprocessDispatcher } from "./local.js";
import type { WebSocketDispatcher, DevicePool } from "./devices.js";

export class DispatcherRouter implements AgentDispatcher {
  constructor(
    private local: LocalSubprocessDispatcher,
    private remote: WebSocketDispatcher,
    private pool: DevicePool,
  ) {}

  async run(spec: AgentSpec, ctx: RunContext): Promise<RunResult> {
    const runOn = ctx.runOn ?? "any";
    if (runOn === "local") return this.local.run(spec, ctx);
    if (runOn === "device") return this.remote.run(spec, ctx);
    // "any": prefer a connected device, else local subprocess.
    if (this.pool.hasAnyConnected()) {
      try {
        return await this.remote.run(spec, ctx);
      } catch (err) {
        console.warn("[dispatcher] remote dispatch failed, falling back to local", err);
        return this.local.run(spec, ctx);
      }
    }
    return this.local.run(spec, ctx);
  }
}
