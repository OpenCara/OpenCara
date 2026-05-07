// Extract the human-readable text from an agent's captured stdout.
//
// Different agent CLIs emit different shapes when run in headless mode:
//
//   - claude --output-format json
//       single JSON object: { type: "result", subtype: "success",
//                              is_error: false, duration_ms, result: "...", ... }
//       The user-facing markdown lives in `.result`.
//
//   - codex --json, pi --mode json, opencode --format json
//       JSONL stream: session_meta header, then per-event frames carrying
//       chunks of the agent's response. Each line is an independent JSON
//       object; the visible answer must be reconstructed from event
//       payloads. Not parsed here yet — see TODO below.
//
// When this helper can't recognise the shape it returns the input verbatim.
// That preserves today's behaviour for stub agents (echo-reviewer.mjs, ad-hoc
// `node`-driven scripts) which already write plain markdown to stdout.
//
// Why this is in `agents/` and not `flows/`: it's an agent-output concern,
// not a flow-execution concern. Flow runners delegate to it.

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

  // TODO: handle JSONL outputs (codex / pi / opencode) by walking event
  // frames and concatenating `agent_message` text. Out of scope for the
  // targeted fix that surfaces this — only Claude is wired to a flow
  // node that posts to GitHub today. File a follow-up issue once a
  // non-Claude agent gets wired to a posting node.

  return raw;
}
