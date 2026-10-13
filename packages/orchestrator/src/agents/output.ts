// Extract the human-readable text from an agent's captured stdout.
//
// The device runner streams the agent's reply as plain markdown and fences
// its reasoning and tool calls into `[think]`/`[tool]` markers on the way to
// the chat panel. Those are transport, not content, and every caller of this
// function wants the content: the review body posted to GitHub, and the
// upstream text a fan-in node pastes into the next agent's prompt.
//
// Why this is in `agents/` and not `flows/`: it's an agent-output concern,
// not a flow-execution concern. Flow runners delegate to it.

import { agentMessageSegments, stripAgentMarkers } from "@opencara/shared";

export function extractAgentResultText(raw: string): string {
  if (raw.trim().length === 0) return "";

  // Marker stripping alone isn't enough for review agents: a model can
  // narrate its progress on the same channel as the answer, so "Let me
  // check X…" paragraphs survive the strip and reach GitHub above the
  // review (PR #322 review 5256477256). The `verdict:` contract line is the
  // reliable boundary between working narration and reply, so when a
  // segment carries one, the answer starts there — including any
  // post-verdict sign-off, which post_review tolerates better than a
  // refusal. With no verdict we can't tell narration from content without
  // guessing, so keep the whole stripped stream; the review-layer
  // `## Summary`/`## Findings` anchor in reviewBody.ts covers the
  // structured-review shape, and non-review consumers (add_comment, fan-in)
  // see the full reply.
  if (!raw.includes("[think]") && !raw.includes("[tool] ")) {
    return stripAgentMarkers(raw);
  }
  const segments = agentMessageSegments(raw)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length === 0) return stripAgentMarkers(raw);
  let firstVerdictSeg = -1;
  for (let i = 0; i < segments.length; i++) {
    if (/^verdict\s*:\s*(approve|request_changes|comment)\s*$/im.test(segments[i]!)) {
      firstVerdictSeg = i;
      break;
    }
  }
  return firstVerdictSeg >= 0
    ? segments.slice(firstVerdictSeg).join("\n\n")
    : stripAgentMarkers(raw);
}
