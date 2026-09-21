// Extract the human-readable text from an agent's captured stdout.
//
// Different agent CLIs emit different shapes when run in headless mode:
//
//   - claude --output-format json
//       single JSON object: { type: "result", subtype: "success",
//                              is_error: false, duration_ms, result: "...", ... }
//       The user-facing markdown lives in `.result`.
//
//   - codex --json
//       JSONL stream of event frames. Frames we care about:
//         { type: "item.completed", item: { type: "agent_message", text: "..." } }
//       Other frames (reasoning, command_execution with aggregated_output,
//       thread.started, turn.completed, etc.) carry tool-use traces that
//       can blow past 1MB on a single run. Without filtering, agent-to-agent
//       fan-in (e.g. pr-review-multi: codex reviewer → claude synthesizer)
//       overflows the synthesizer's context window with reasoning + command
//       output that the synthesizer doesn't need. Surfaced empirically on
//       opencara.com flow-run 01KR1CE7AYPHE8VKFA0N7H7ETE.
//
//   - pi --mode json, opencode --format json
//       Similar JSONL streams. Not parsed yet — those agents aren't wired
//       to a flow node that consumes the output today; extend the parser
//       when they are.
//
// When this helper can't recognise the shape it returns the input verbatim,
// so agents that emit plain markdown (no JSON envelope) flow through
// unchanged.
//
// Why this is in `agents/` and not `flows/`: it's an agent-output concern,
// not a flow-execution concern. Flow runners delegate to it.

import { acpMessageSegments, stripAcpMarkers } from "@opencara/shared";

export function extractAgentResultText(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";

  // Claude's `--output-format json` emits a single JSON document. Agent's
  // visible output lives in `.result`. The wrapper carries metadata
  // (duration_ms, usage, model_id, etc.) we don't want in a PR review body.
  //
  // Detection heuristic: starts with `{` AND parses as one JSON object AND
  // has a string `result` field. The first character check is cheap and
  // saves us parsing JSONL-shaped streams as a single document (which would
  // succeed for line 1 only and silently produce wrong results).
  //
  // `is_error: true` envelopes are deliberately NOT unwrapped. In that
  // case `.result` is whatever Claude generated before the error (often
  // a partial response or "Maximum tool use limit reached"-style text);
  // posting it as a clean review body would mask the failure. Falling
  // through to verbatim keeps the full envelope (including `is_error`,
  // `subtype`, `duration_ms`) visible to whatever surface receives the
  // output. PR #34 review raised this; locked in with a unit test.
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (
        parsed !== null &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "result" in parsed &&
        typeof (parsed as { result: unknown }).result === "string" &&
        (parsed as { is_error?: unknown }).is_error !== true
      ) {
        return (parsed as { result: string }).result;
      }
    } catch {
      // Not valid JSON; fall through to verbatim.
    }
  }

  // Codex JSONL: extract every `item.completed` agent_message text, drop
  // everything else. We sniff for it by checking whether the first
  // non-empty line looks like a known JSONL frame type (`thread.started`,
  // `turn.started`, or an `item.*` event). If so, walk every line and
  // collect agent_message texts in order.
  if (looksLikeCodexJsonl(trimmed)) {
    const messages = extractCodexAgentMessages(trimmed);
    if (messages.length > 0) {
      return messages.join("\n\n");
    }
    // No agent_message frames found — agent failed before producing one,
    // or all output was reasoning/tool-calls. Fall through to verbatim
    // so the operator can still see what went wrong rather than getting
    // an empty string.
  }

  // ACP agents emit plain markdown, so neither branch above claims them —
  // but the device runner fences their reasoning and tool calls into
  // `[think]`/`[tool]` markers on the way to the chat panel. Those are
  // transport, not content, and every caller of this function wants the
  // content: the review body posted to GitHub, and the upstream text a
  // fan-in node pastes into the next agent's prompt.
  //
  // Marker stripping alone isn't enough for review agents: devin narrates
  // its progress through `agent_message_chunk` — the same channel as the
  // answer — so "Let me check X…" paragraphs survive the strip and reach
  // GitHub above the review (PR #322 review 5256477256). The `verdict:`
  // contract line is the reliable boundary between working narration and
  // reply, so when a segment carries one, the answer starts there —
  // including any post-verdict sign-off, which post_review tolerates
  // better than a refusal. With no verdict we can't tell narration from
  // content without guessing, so keep the whole stripped stream; the
  // review-layer `## Summary`/`## Findings` anchor in reviewBody.ts covers
  // the structured-review shape, and non-review consumers (add_comment,
  // fan-in) see exactly what they saw before this change.
  if (!raw.includes("[think]") && !raw.includes("[tool] ")) {
    return stripAcpMarkers(raw);
  }
  const segments = acpMessageSegments(raw)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return stripAcpMarkers(raw);
  let firstVerdictSeg = -1;
  for (let i = 0; i < segments.length; i++) {
    if (/^verdict\s*:\s*(approve|request_changes|comment)\s*$/im.test(segments[i]!)) {
      firstVerdictSeg = i;
      break;
    }
  }
  return firstVerdictSeg >= 0
    ? segments.slice(firstVerdictSeg).join("\n\n")
    : stripAcpMarkers(raw);
}

const CODEX_JSONL_TYPE_HINTS = new Set([
  "thread.started",
  "thread.completed",
  "turn.started",
  "turn.completed",
  "item.started",
  "item.completed",
  "item.updated",
]);

function looksLikeCodexJsonl(input: string): boolean {
  // Find first non-blank line; check whether it parses to an object with
  // a `type` field codex's --json emits. Cheap front-of-stream sniff.
  const firstLine = input.split("\n").find((l) => l.trim().length > 0);
  if (!firstLine) return false;
  try {
    const parsed: unknown = JSON.parse(firstLine);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return false;
    }
    const type = (parsed as { type?: unknown }).type;
    return typeof type === "string" && CODEX_JSONL_TYPE_HINTS.has(type);
  } catch {
    return false;
  }
}

interface CodexItemCompletedFrame {
  type: "item.completed";
  item: {
    type?: string;
    text?: string;
  };
}

function extractCodexAgentMessages(input: string): string[] {
  const out: string[] = [];
  for (const line of input.split("\n")) {
    const t = line.trim();
    if (t.length === 0 || !t.startsWith("{")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    if (
      parsed === null ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      (parsed as { type?: unknown }).type !== "item.completed"
    ) {
      continue;
    }
    const frame = parsed as CodexItemCompletedFrame;
    if (frame.item?.type !== "agent_message") continue;
    const text = frame.item.text;
    if (typeof text !== "string" || text.length === 0) continue;
    out.push(text);
  }
  return out;
}
