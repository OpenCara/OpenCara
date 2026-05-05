import type { AgentCall } from "@opencara/shared";

// Pulled out of the executeJob path so it's testable in isolation. Stateful
// stream parser: callers feed chunks of stdout, the parser emits agent-call
// payloads when it sees complete ```opencara-call\n…\n``` fenced blocks.
//
// Why "fire-and-forget": the agent process closes its stdin after the
// initial JSON is delivered (see runner/spawn.ts), so a request/response
// protocol over stdin isn't possible. The agent emits its intent on stdout,
// the CLI proxies, and the user sees the side effect (a draft mutation
// landing on the issue page) — that's the feedback loop.

export type AgentCallEmitter = (call: Omit<AgentCall, "type" | "runId">) => void;

// Bounded buffer to defend against an agent emitting a fence open that
// never closes. We drop the oldest data on overflow rather than holding
// stdout in memory forever; the agent's normal log frames stream through
// the parallel onLog path either way.
const MAX_BUFFER_BYTES = 64 * 1024;

// `[\s\S]*?` is non-greedy so two adjacent blocks don't collapse into one.
const FENCE_RE = /```opencara-call\r?\n([\s\S]*?)\r?\n```/;

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
    const p = parsed as Record<string, unknown>;
    if (p.kind !== "issue.body.set") {
      // Allowlist gate. Future kinds added here as the protocol expands.
      return;
    }
    if (typeof p.issueNumber !== "number" || typeof p.bodyMd !== "string") {
      return;
    }
    const callId = typeof p.callId === "string" && p.callId.length > 0
      ? p.callId
      : `call_${Date.now().toString(36)}`;
    this.emit({
      callId,
      kind: "issue.body.set",
      issueNumber: p.issueNumber,
      bodyMd: p.bodyMd,
    });
  }
}
