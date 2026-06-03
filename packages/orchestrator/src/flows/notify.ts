/**
 * Payload contract for the Postgres `flow_runs` NOTIFY channel.
 *
 * The engine fires this channel whenever a flow run changes terminal/lifecycle
 * state. Two kinds of listener consume it:
 *
 *  - run-scoped (the flow-run SSE stream) — cares only about *one* run id.
 *  - project-scoped (the kanban board SSE stream) — cares about *every* run in
 *    its project, so it can refresh implement statuses on the cards.
 *
 * Originally the payload was the bare flowRunId, so the project-scoped listener
 * had no way to tell whether a notify belonged to its project — every kanban
 * stream rebuilt its full snapshot on *every* run in *every* project. On a
 * busy multi-project instance that turned into a firehose that saturated the
 * DB pool (see OpenCara#146). Carrying `projectId` lets the kanban stream drop
 * notifies for other projects before doing any DB work.
 */
export const FLOW_RUNS_CHANNEL = "flow_runs";

export interface FlowRunsNotify {
  flowRunId: string;
  projectId: string;
}

export function serializeFlowRunsNotify(n: FlowRunsNotify): string {
  return JSON.stringify(n);
}

/**
 * Parse a `flow_runs` NOTIFY payload. Returns null when the payload is not the
 * expected JSON shape so callers can decide how to degrade (run-scoped
 * listeners ignore it; project-scoped listeners rebuild conservatively).
 */
export function parseFlowRunsNotify(raw: string): FlowRunsNotify | null {
  try {
    const parsed = JSON.parse(raw) as Partial<FlowRunsNotify>;
    if (
      parsed &&
      typeof parsed.flowRunId === "string" &&
      typeof parsed.projectId === "string"
    ) {
      return { flowRunId: parsed.flowRunId, projectId: parsed.projectId };
    }
  } catch {
    // Not JSON — fall through to null.
  }
  return null;
}
