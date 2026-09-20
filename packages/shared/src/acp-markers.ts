// The ACP device runner fences an agent's internal activity into markers on
// stdout so the chat panel can render it as collapsible blocks:
//
//   \n[think]\n … \n[/think]\n     reasoning stream (agent_thought_chunk)
//   \n[tool] <title>\n             a tool call starting
//   \n[tool] <title> → <status>\n  that call reaching a terminal status
//
// They are a TRANSPORT concern, not content. Every consumer that wants the
// agent's actual prose — a PR review body, the prompt handed to a downstream
// fan-in node, replayed conversation history — has to take them back out.
//
// This lives in shared because it had already been reimplemented once (the
// chat panel's history path) while the orchestrator had no stripping at all,
// so agent output reached GitHub with `[tool] Read File → completed` lines in
// the review body. Two copies of a parser for a format that changes is how
// the next format change silently stops matching; keep exactly one.

// All three are `m`-anchored rather than matching a leading `\n`. Consuming
// the newline BEFORE a marker line makes adjacent markers unmatchable: the
// first match eats the separator the second one needs as its anchor, so
// `[tool] a\n[tool] b` used to lose only the first line. `^` under /m matches
// at every line start and consumes nothing before the marker, so runs of them
// strip cleanly.
/** A `[think]…[/think]` block: both fences and the reasoning between them. */
const THINK_BLOCK_RE = /^\[think\]\n[\s\S]*?^\[\/think\]\n?/gm;
/** A whole `[tool] …` line. Line-anchored, so prose mentioning it is safe. */
const TOOL_LINE_RE = /^\[tool\] [^\n]*\n?/gm;
/** Three or more newlines left where stripped blocks used to sit. */
const BLANK_RUN_RE = /\n{3,}/g;

/**
 * Remove the ACP runner's `[think]` blocks and `[tool]` lines from agent
 * output, leaving the prose the agent actually wrote.
 *
 * An unterminated `[think]` (the run was cancelled mid-thought, so no closing
 * fence arrived) is deliberately left alone: the non-greedy block regex won't
 * match it, and dropping everything to end-of-string on a lone opener risks
 * eating a real answer. `flush()` on the device closes the fence in every
 * normal path, so this is the rare-crash case only.
 *
 * A line of genuine prose that begins with `[tool] ` would be removed too.
 * That is accepted: the marker shape is distinctive, and the alternative —
 * matching the exact emitted grammar — would break the moment the runner's
 * format changes, which is the failure this function exists to survive.
 */
export function stripAcpMarkers(text: string): string {
  // Nothing to strip → hand back the EXACT input. extractAgentResultText's
  // documented fall-through is verbatim, and callers (plus its tests) rely on
  // that down to the trailing newline; trimming output that never contained a
  // marker would silently rewrite every non-ACP agent's result.
  // Substring probe, not `.test()`: these are /g regexes, and `.test()`
  // advances their shared `lastIndex`, which turns the guard into a
  // stateful trap for the next caller.
  if (!text.includes("[think]") && !text.includes("[tool] ")) return text;
  return text
    .replace(THINK_BLOCK_RE, "")
    .replace(TOOL_LINE_RE, "")
    .replace(BLANK_RUN_RE, "\n\n")
    .trim();
}

/**
 * Every stream construct that ends one message run and starts the next:
 * a terminated `[think]…[/think]` block, a `[tool] …` line, or a
 * `[think]` opener with no closing fence (the run ended mid-thought —
 * everything after it is reasoning in flight, never output). Ordered so
 * the terminated think shape wins over the unterminated one at the same
 * position; the dangling alternative is only reachable when no closer
 * exists downstream.
 */
const STREAM_CONSTRUCT_RE =
  /^\[think\]\n[\s\S]*?^\[\/think\]\n?|^\[tool\] [^\n]*\n?|^\[think\][\s\S]*$/gm;

/**
 * Split captured ACP stdout into the agent's message runs — the prose
 * emitted between stream constructs.
 *
 * Why this exists: ACP agents (devin, codex-acp, agy) narrate progress on
 * the same `agent_message_chunk` channel that carries the final answer —
 * "Let me check X…" — so a run's stdout interleaves working narration
 * with the reply and `stripAcpMarkers` alone leaves all of it behind
 * (PR #322 review 5256477256 posted eleven paragraphs of narration above
 * the review). Consumers that want just the answer pick from the tail of
 * this list; consumers that want the whole transcript use
 * `stripAcpMarkers`.
 *
 * A trailing unterminated `[think]` truncates the list rather than
 * returning its reasoning as a segment: text after the opener is a
 * thought the run never finished, not a message it sent.
 */
export function acpMessageSegments(raw: string): string[] {
  const segments: string[] = [];
  let start = 0;
  for (const m of raw.matchAll(STREAM_CONSTRUCT_RE)) {
    const idx = m.index!;
    if (idx > start) segments.push(raw.slice(start, idx));
    if (m[0].startsWith("[think]") && !m[0].includes("[/think]")) {
      return segments;
    }
    start = idx + m[0].length;
  }
  segments.push(raw.slice(start));
  return segments;
}
