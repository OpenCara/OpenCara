import type { AgentRun, AgentSpec } from "@openkira/shared";

export interface AgentDispatcher {
  enqueue(spec: AgentSpec, triggerEventId?: string): Promise<AgentRun>;
}
