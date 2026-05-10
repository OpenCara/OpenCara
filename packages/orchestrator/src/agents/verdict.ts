// Reviewer-agent verdict contract: when an agent's output flows into a
// `github.post_review` action node, the orchestrator injects a skill
// envelope (see flows/skills/prReviewVerdict.ts) that requires the agent
// to begin its reply with a single line of the form:
//
//   verdict: approve
//   verdict: request_changes
//   verdict: comment
//
// The action runner calls the parser below to map that line onto the
// GitHub Reviews API's `event` enum (uppercased). The line is stripped
// from the body before posting, so the rendered review reads as plain
// markdown without the contract noise.
//
// On any deviation (line not first non-blank, missing colon, unknown
// token, empty input), the parser returns `null` and the runner falls
// back to the action node's static `config.event`. We deliberately do
// NOT coerce mixed-case or whitespace-y tokens (e.g. `Verdict: maybe`,
// `verdict: request changes`) — leaving them in the body and posting as
// the static fallback makes the malformed agent output visible to the
// operator instead of silently picking a wrong event.
export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

const VERDICT_LINE_RE = /^verdict:\s*(approve|request_changes|comment)\s*$/i;

export interface ParsedReviewVerdict {
  verdict: ReviewVerdict;
  bodyWithoutVerdict: string;
}

export function parseReviewVerdict(body: string): ParsedReviewVerdict | null {
  if (!body) return null;

  // Normalize CRLF so the line walker behaves identically across editors.
  const normalized = body.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  let firstNonBlankIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim().length > 0) {
      firstNonBlankIdx = i;
      break;
    }
  }
  if (firstNonBlankIdx === -1) return null;

  const match = VERDICT_LINE_RE.exec(lines[firstNonBlankIdx]!.trim());
  if (!match) return null;

  const token = match[1]!.toUpperCase();
  // The regex group is constrained to the three canonical tokens; the
  // cast is exhaustive as long as the alternation above stays in sync
  // with the ReviewVerdict union.
  const verdict = token as ReviewVerdict;

  const remainingLines = lines.slice(firstNonBlankIdx + 1);
  const bodyWithoutVerdict = remainingLines.join("\n").trim();

  return { verdict, bodyWithoutVerdict };
}
