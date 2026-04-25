import type { AgentSpec } from "@openkira/shared";

export type LogStream = "stdout" | "stderr";

export interface RunContext {
  /** Optional structured payload to write to the agent's stdin (closed after). */
  stdinJson?: unknown;
  /** Called for every chunk of stdout/stderr the agent emits. */
  onLog: (stream: LogStream, chunk: string) => void;
  /** Optional hint for routers; default "any" means "best available". */
  runOn?: "any" | "local" | "device";
}

export interface RunResult {
  exitCode: number;
  /** Full stdout buffer for the next pipeline step / action input. */
  stdoutCaptured: string;
}

export interface AgentDispatcher {
  run(spec: AgentSpec, ctx: RunContext): Promise<RunResult>;
}
