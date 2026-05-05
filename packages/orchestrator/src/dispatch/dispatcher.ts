import type { AgentSpec } from "@opencara/shared";

export type LogStream = "stdout" | "stderr";

export interface RunContext {
  /** Optional structured payload to write to the agent's stdin (closed after). */
  stdinJson?: unknown;
  /** Called for every chunk of stdout/stderr the agent emits. */
  onLog: (stream: LogStream, chunk: string) => void;
  /**
   * Pin to a specific agent_host. If set and that host isn't connected
   * & idle, the dispatcher errors with a clear message — pinning is
   * an explicit operator choice and silently rerouting would surprise
   * them. If null, any idle host is picked.
   */
  hostId?: string | null;
  /**
   * Project the run is scoped to. Used by the agent-call handler in the
   * device pool to gate mutations: a run dispatched for project X can only
   * mutate project X's resources. Required for canvas-mode runs; null is
   * accepted for legacy paths that don't use agent callbacks.
   */
  projectId?: string | null;
}

export interface RunResult {
  exitCode: number;
  /** Full stdout buffer for the next pipeline step / action input. */
  stdoutCaptured: string;
}

export interface AgentDispatcher {
  run(spec: AgentSpec, ctx: RunContext): Promise<RunResult>;
}
