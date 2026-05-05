import {
  FlowNodeConfigSetCallSchema,
  IssueBodySetCallSchema,
  TemplateNodeConfigSetCallSchema,
  type AgentCall,
} from "@opencara/shared";
import { z } from "zod";

// Pulled out of the executeJob path so it's testable in isolation. Stateful
// stream parser: callers feed chunks of stdout, the parser emits agent-call
// payloads when it sees complete ```opencara-call\n…\n``` fenced blocks.
//
// Why "fire-and-forget": the agent process closes its stdin after the
// initial JSON is delivered (see runner/spawn.ts), so a request/response
// protocol over stdin isn't possible. The agent emits its intent on stdout,
// the CLI proxies, and the user sees the side effect (a draft mutation
// landing on the issue/flow/template page) — that's the feedback loop.

// Plain `Omit<AgentCall, "type" | "runId">` collapses the discriminated
// union into one wide object — callers can no longer narrow on `kind`.
// Distribute Omit over each variant so the switch in run.ts narrows.
type DistributiveOmit<T, K extends keyof T | (string & {})> = T extends unknown
  ? Omit<T, K & keyof T>
  : never;
export type ParsedAgentCall = DistributiveOmit<AgentCall, "type" | "runId">;
export type AgentCallEmitter = (call: ParsedAgentCall) => void;

// Bounded buffer to defend against an agent emitting a fence open that
// never closes. We drop the oldest data on overflow rather than holding
// stdout in memory forever; the agent's normal log frames stream through
// the parallel onLog path either way.
const MAX_BUFFER_BYTES = 64 * 1024;

// `[\s\S]*?` is non-greedy so two adjacent blocks don't collapse into one.
const FENCE_RE = /```opencara-call\r?\n([\s\S]*?)\r?\n```/;

// Per-kind variant schemas, each made parseable in isolation by stripping the
// envelope fields the parser fills in itself (`type`, `runId`). We then use
// the kind discriminator to route to the right schema. Adding a new kind
// here + in shared/host-protocol.ts is the whole protocol surface.
const VARIANT_SCHEMAS = {
  "issue.body.set": IssueBodySetCallSchema.omit({ type: true, runId: true }),
  "flow.node.config.set": FlowNodeConfigSetCallSchema.omit({
    type: true,
    runId: true,
  }),
  "template.node.config.set": TemplateNodeConfigSetCallSchema.omit({
    type: true,
    runId: true,
  }),
} as const;

type AllowedKind = keyof typeof VARIANT_SCHEMAS;

const KindSchema = z.enum([
  "issue.body.set",
  "flow.node.config.set",
  "template.node.config.set",
]);

export class AgentCallParser {
  private buffer = "";

  constructor(private emit: AgentCallEmitter) {}

  feed(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_BUFFER_BYTES) {
      // Trim on a newline boundary so we don't accidentally split a fence
      // open marker. If there's no newline in the upper half, the buffer
      // is one giant line; in that case it can't be a closed fence anyway,
      // so we just drop the oldest half.
      const cutoff = Math.floor(MAX_BUFFER_BYTES / 2);
      const nl = this.buffer.indexOf("\n", this.buffer.length - cutoff);
      this.buffer = nl >= 0 ? this.buffer.slice(nl + 1) : this.buffer.slice(-cutoff);
    }
    while (true) {
      const m = FENCE_RE.exec(this.buffer);
      if (!m) break;
      const inner = m[1] ?? "";
      const consumedTo = m.index + m[0].length;
      this.buffer = this.buffer.slice(consumedTo);
      this.tryEmit(inner);
    }
  }

  private tryEmit(inner: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(inner);
    } catch {
      // Not valid JSON; the user sees the raw block in chat as a code
      // fence (since the parallel log-frame path forwarded the same bytes
      // unchanged). Silent skip — a noisy log here would clutter the
      // chat reply.
      return;
    }
    if (!parsed || typeof parsed !== "object") return;
    const raw = parsed as Record<string, unknown>;

    // Allowlist gate. Unknown kinds drop silently — same posture as the
    // earlier hardcoded `kind === "issue.body.set"` check.
    const kindResult = KindSchema.safeParse(raw.kind);
    if (!kindResult.success) return;

    // The agent doesn't have to emit a callId; default to a deterministic
    // local id so logs stay correlatable. Inject before validation so the
    // schema's `callId: z.string()` requirement is satisfied.
    const withCallId = {
      ...raw,
      callId:
        typeof raw.callId === "string" && raw.callId.length > 0
          ? raw.callId
          : `call_${Date.now().toString(36)}`,
    };

    const schema = VARIANT_SCHEMAS[kindResult.data as AllowedKind];
    const result = schema.safeParse(withCallId);
    if (!result.success) return;
    this.emit(result.data as ParsedAgentCall);
  }
}
