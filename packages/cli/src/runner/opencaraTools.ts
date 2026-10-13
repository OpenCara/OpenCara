// The opencara tools: the chat skills tell agents to update an issue body
// draft, a flow / template node config, or dispatch a kanban wave. The
// device has no project access of its own, so each call travels to the
// orchestrator as an `agent-call-request` frame over the device WebSocket
// and resolves with the matching `agent-call-result`. Scope checks and the
// mutation itself happen server-side, keyed by the run id.

import { Type, type Static, type TSchema } from "@earendil-works/pi-ai";
import { defineExtension, defineTool, type Extension } from "@earendil-works/pi-durable";
import type { AgentCallRequest, AgentCallResultMessage } from "@opencara/shared";

type CallOutcome = AgentCallResultMessage["result"];
type CallPayload = AgentCallRequest extends infer R
  ? R extends AgentCallRequest
    ? Omit<R, "type" | "runId" | "callId">
    : never
  : never;

/**
 * Correlates one run's tool calls with their results. One per run: pending
 * calls must not straddle runs, so `shutdown` settles whatever is left.
 */
export class AgentCallBridge {
  private readonly pending = new Map<string, (outcome: CallOutcome) => void>();
  private nextCallId = 1;

  constructor(
    private readonly runId: string,
    private readonly send: (req: AgentCallRequest) => void,
  ) {}

  /** Resolves with the orchestrator's verdict, or `ok: false` when the
   *  call is aborted (cancel, timeout) or the run ends first. */
  call(payload: CallPayload, signal: AbortSignal | undefined): Promise<CallOutcome> {
    const { promise, resolve } = Promise.withResolvers<CallOutcome>();
    const callId = `c${this.nextCallId++}`;
    const onAbort = () => settle({ ok: false, reason: "aborted" });
    const settle = (outcome: CallOutcome) => {
      this.pending.delete(callId);
      signal?.removeEventListener("abort", onAbort);
      resolve(outcome);
    };
    if (signal?.aborted) {
      onAbort();
      return promise;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    this.pending.set(callId, settle);
    this.send({ type: "agent-call-request", runId: this.runId, callId, ...payload } as AgentCallRequest);
    return promise;
  }

  /** Feed an inbound result; results for other runs or settled calls are dropped. */
  onResult(msg: AgentCallResultMessage): void {
    if (msg.runId !== this.runId) return;
    this.pending.get(msg.callId)?.(msg.result);
  }

  shutdown(reason: string): void {
    for (const settle of [...this.pending.values()]) settle({ ok: false, reason });
  }
}

const Slug = Type.String({ minLength: 1 });
const NodeConfig = Type.Record(Type.String(), Type.Unknown());

export function createOpencaraTools(bridge: AgentCallBridge): Extension {
  const tool = <T extends TSchema>(
    name: string,
    description: string,
    parameters: T,
    payload: (args: Static<T>) => CallPayload,
  ) =>
    defineTool({
      name,
      description,
      parameters,
      execute: async (args, _api, context) => {
        const outcome = await bridge.call(payload(args), context.abortSignal);
        return outcome.ok
          ? { output: [{ type: "text", text: "ok" }] }
          : { output: [{ type: "text", text: `rejected: ${outcome.reason}` }], isError: true };
      },
    });

  return defineExtension({
    name: "opencara",
    tools: [
      tool(
        "opencara_issue_body_set",
        "Replace the draft Markdown body of an issue in the run's project. The change goes " +
          "to the draft store — the user publishes it to GitHub from the canvas. Rejected " +
          "with a reason if the issue isn't in the run's project.",
        Type.Object({ issueNumber: Type.Integer(), bodyMd: Type.String() }),
        (args) => ({ kind: "issue.body.set", ...args }),
      ),
      tool(
        "opencara_flow_node_config_set",
        "Replace the config of a node in the named flow of the run's project. Rejected " +
          "with a reason if the flow or node doesn't exist or is out of scope.",
        Type.Object({ flowSlug: Slug, nodeId: Slug, config: NodeConfig }),
        (args) => ({ kind: "flow.node.config.set", ...args }),
      ),
      tool(
        "opencara_template_node_config_set",
        "Replace the config of a node in the user's draft of the named flow template " +
          "(per-user, not per-project). Rejected with a reason if the run's user doesn't " +
          "own the draft.",
        Type.Object({ templateSlug: Slug, nodeId: Slug, config: NodeConfig }),
        (args) => ({ kind: "template.node.config.set", ...args }),
      ),
      tool(
        "opencara_kanban_wave_dispatch",
        "Dispatch up to 10 issues in parallel to the named flow of the run's project. " +
          "Rejected if the flow doesn't exist or is disabled, or any issue isn't in the project.",
        Type.Object({
          flowSlug: Slug,
          issueNumbers: Type.Array(Type.Integer(), { minItems: 1, maxItems: 10 }),
        }),
        (args) => ({ kind: "kanban.wave.dispatch", ...args }),
      ),
    ],
  });
}
