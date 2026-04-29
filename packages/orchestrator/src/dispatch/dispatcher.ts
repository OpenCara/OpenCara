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
}

export interface RunResult {
  exitCode: number;
  /** Full stdout buffer for the next pipeline step / action input. */
  stdoutCaptured: string;
}

export interface AgentDispatcher {
  run(spec: AgentSpec, ctx: RunContext): Promise<RunResult>;
}
