import { randomUUID } from "node:crypto";
import type { AgentRun, AgentSpec } from "@openkira/shared";
import type { AgentDispatcher } from "./dispatcher.js";

export class LocalSubprocessDispatcher implements AgentDispatcher {
  async enqueue(spec: AgentSpec, triggerEventId?: string): Promise<AgentRun> {
    const now = new Date().toISOString();
    return {
      id: randomUUID(),
      spec,
      triggerEventId,
      status: "queued",
      hostId: null,
      createdAt: now,
      startedAt: null,
      finishedAt: null,
      exitCode: null,
    };
  }
}
