import type { AgentSpec } from "@opencara/shared";

export type LogStream = "stdout" | "stderr";

export interface RunContext {
  /**
   * Optional caller-supplied id for this run. When set, the dispatcher
   * uses it as both the WS-frame correlation key AND surfaces it back
   * as `RunResult.runId`. Callers (chat / agent-test / worktree-cleanup)
   * generate their `agent_runs.id` up front so they can return it to
   * the client before the dispatcher resolves; passing it in here keeps
   * the WS frame, the DB row, the log table rows, and any future cancel
   * lookup all keyed on the same string. Unset → dispatcher mints a ULID.
   */
  runId?: string;
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
  /**
   * Owning user. Per-user resources (e.g. flow-template drafts, prompts)
   * key on this — agent-calls that mutate them require it. Null is fine
   * for runs that only mutate project-scoped resources.
   */
  userId?: string | null;
  /**
   * Chat session id. Threaded into pm_waves.thread_key so the PM panel
   * can surface active waves from its own conversation thread.
   * Optional; null for non-chat dispatch paths.
   */
  sessionId?: string | null;
}

export interface RunResult {
  exitCode: number;
  /** Full stdout buffer for the next pipeline step / action input. */
  stdoutCaptured: string;
  /**
   * Device that actually ran the job. Equals `ctx.hostId` for pinned
   * dispatches; for unpinned ones it's whoever the dispatcher's
   * pickIdle() chose. The flow engine uses this to thread structured
   * handles (e.g. a worktree path) back to downstream nodes that must
   * execute on the SAME device.
   */
  agentHostId: string;
  /**
   * ACP session id the run executed under, surfaced from the device's
   * `done` frame. Used by the flow engine to persist per-(repo, branch)
   * session continuity via `worktree write-session` so the next
   * iteration resumes via `session/load`. Null for non-ACP runs
   * (worktree-allocate, write-session itself, etc.).
   */
  acpSessionId: string | null;
}

export interface AgentDispatcher {
  run(spec: AgentSpec, ctx: RunContext): Promise<RunResult>;
  /**
   * True if the host is currently connected and dispatchable. Used by
   * callers that want to fall back to an unpinned dispatch when their
   * preferred host is offline (e.g. worktree allocation can graceful-
   * degrade to a fresh checkout on any idle device when the previous
   * pinned one is gone).
   */
  isConnected(hostId: string): boolean;
  /**
   * Signal the device to terminate an in-flight run. Returns true iff
   * a `cancel` frame was actually delivered to a connected device.
   * Callers should still flip the DB status to "cancelled" regardless —
   * if the device is offline, the DB write is the only thing the
   * client SSE can observe.
   *
   * `reason` is forwarded over the wire and ends up on
   * `agent_runs.cancel_reason` (set by the caller, not by this method).
   */
  cancel(
    runId: string,
    hostId: string,
    reason: "user_stopped" | "wave_cancelled",
  ): boolean;
}
