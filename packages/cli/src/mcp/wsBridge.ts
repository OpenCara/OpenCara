// Bridges MCP tool calls (from the IPC server) onto the device WebSocket
// as `agent-call-request` frames, and resolves them when the matching
// `agent-call-result` arrives back from the orchestrator.
//
// This is the production `ToolCallRouter` impl. The CLI device run loop
// (#29 territory) constructs one per run, hands its `router` to McpHost,
// and forwards inbound `agent-call-result` frames into `onResult`.
//
// Pure correlation logic — no transport, no protocol decoding. Tests can
// drive it with synthetic frames.

import type {
  AgentCallRequest,
  AgentCallResultMessage,
} from "@opencara/shared";
import type { ToolCallResult, ToolCallRouter } from "./tools.js";

export interface WsAgentCallBridgeOptions {
  runId: string;
  /**
   * Sends one `agent-call-request` frame over the device's WebSocket.
   * Implementation owns the actual WS write — keeping this abstract so
   * the bridge unit-tests with a synthetic sender.
   */
  sendRequest: (req: AgentCallRequest) => void;
}

/**
 * One bridge per run. Throw away when the run ends — the pending map
 * holds promises for in-flight tool calls and we don't want them
 * straddling runs.
 */
export class WsAgentCallBridge {
  private readonly pending = new Map<
    string,
    { resolve: (r: ToolCallResult) => void; reject: (e: Error) => void }
  >();
  private nextCallId = 1;

  constructor(private readonly opts: WsAgentCallBridgeOptions) {}

  /**
   * Pass to McpHost as the tool-call router. Each invocation mints a
   * callId, sends an `agent-call-request`, and parks the resolver until
   * `onResult` finds a match.
   */
  readonly router: ToolCallRouter = {
    call: (kind, args) => this.dispatch(kind, args),
  };

  /**
   * Forward an inbound `agent-call-result` frame from the WS layer.
   * Resolves the matching pending call. Stale callIds (the run already
   * ended, or someone replied twice) are dropped silently.
   */
  onResult(msg: AgentCallResultMessage): void {
    if (msg.runId !== this.opts.runId) return; // not ours
    const p = this.pending.get(msg.callId);
    if (!p) return;
    this.pending.delete(msg.callId);
    p.resolve(msg.result);
  }

  /**
   * Reject every in-flight tool call. Call when the run ends or the WS
   * disconnects so opencara-mcp doesn't hang forever waiting on a result
   * that will never arrive.
   */
  shutdown(reason: string): void {
    if (this.pending.size === 0) return;
    const err = new Error(`bridge closed: ${reason}`);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
  }

  private dispatch(kind: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const callId = `bc${this.nextCallId++}`;
    const req = buildAgentCallRequest(this.opts.runId, callId, kind, args);
    if (!req) {
      // Unknown kind — fail fast rather than send a malformed frame.
      // The agent sees `{ ok: false }` as its tool result.
      return Promise.resolve({
        ok: false,
        reason: `unknown agent-call kind: ${kind}`,
      });
    }
    return new Promise<ToolCallResult>((resolve, reject) => {
      this.pending.set(callId, { resolve, reject });
      try {
        this.opts.sendRequest(req);
      } catch (err) {
        this.pending.delete(callId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }
}

/**
 * Build an `AgentCallRequest` from a tool-call kind + args. Returns null
 * for unknown kinds; the bridge surfaces those as `{ ok: false }` rather
 * than throwing — the MCP SDK already validated args against the tool's
 * input schema by the time we get here, so an unknown kind would only
 * happen through a registry/wire mismatch worth surfacing as a domain
 * error.
 */
function buildAgentCallRequest(
  runId: string,
  callId: string,
  kind: string,
  args: Record<string, unknown>,
): AgentCallRequest | null {
  switch (kind) {
    case "issue.body.set":
      return {
        type: "agent-call-request",
        runId,
        callId,
        kind: "issue.body.set",
        issueNumber: Number(args["issueNumber"]),
        bodyMd: String(args["bodyMd"] ?? ""),
      };
    case "flow.node.config.set":
      return {
        type: "agent-call-request",
        runId,
        callId,
        kind: "flow.node.config.set",
        flowSlug: String(args["flowSlug"] ?? ""),
        nodeId: String(args["nodeId"] ?? ""),
        config: (args["config"] as Record<string, unknown>) ?? {},
      };
    case "template.node.config.set":
      return {
        type: "agent-call-request",
        runId,
        callId,
        kind: "template.node.config.set",
        templateSlug: String(args["templateSlug"] ?? ""),
        nodeId: String(args["nodeId"] ?? ""),
        config: (args["config"] as Record<string, unknown>) ?? {},
      };
    case "kanban.wave.dispatch":
      return {
        type: "agent-call-request",
        runId,
        callId,
        kind: "kanban.wave.dispatch",
        flowSlug: String(args["flowSlug"] ?? ""),
        issueNumbers: Array.isArray(args["issueNumbers"])
          ? (args["issueNumbers"] as unknown[]).map((n) => Number(n))
          : [],
      };
    default:
      return null;
  }
}
