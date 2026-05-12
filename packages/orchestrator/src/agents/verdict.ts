// Reviewer-agent verdict contract: when an agent's output flows into a
// `github.post_review` action node, the orchestrator injects a skill
// envelope (see flows/skills/prReviewVerdict.ts) that asks the agent
// to emit a single line of the form:
//
//   verdict: approve
//   verdict: request_changes
//   verdict: comment
//
// The action runner calls the parser below to map that line onto the
// GitHub Reviews API's `event` enum (uppercased). The matched line is
// stripped from the body before posting so the contract marker doesn't
// double-render alongside the colored review badge.
//
// Position rule: the contract still asks agents to put the verdict line
// first, but the parser accepts it anywhere — Codex and other
// reasoning-heavy agents routinely emit a preamble ("Let me check
// X...") before honoring the contract, and the previous strict-first
// rule silently demoted those reviews to COMMENT via the static
// fallback. Surprised flow_run_id=01KRDJSG99079G72EB0T76B9A3.
//
// Token rule stays strict: missing colon, unknown token (`maybe`,
// `lgtm`), or whitespace-tokens (`request changes` with a space) still
// return `null` and the runner falls back to `node.config.event`. Only
// the position rule is relaxed; we still want malformed tokens to be
// operator-visible rather than silently coerced.
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

  // Scan every line for a standalone `verdict: <token>` match. First
  // match wins — a reviewer that quotes another verdict mid-paragraph
  // would tag the wrong event, but that's been observed exactly never;
  // the common case is a single contract line, preceded or not by
  // preamble.
  let verdictIdx = -1;
  let token: ReviewVerdict | null = null;
  for (let i = 0; i < lines.length; i++) {
    const m = VERDICT_LINE_RE.exec(lines[i]!.trim());
    if (m) {
      verdictIdx = i;
      // The regex group is constrained to the three canonical tokens;
      // the cast stays exhaustive as long as the alternation matches
      // the ReviewVerdict union.
      token = m[1]!.toUpperCase() as ReviewVerdict;
      break;
    }
  }
  if (verdictIdx === -1 || !token) return null;

  // Strip only the matched line. Preamble and post-amble both stay in
  // the body so the operator sees what the agent actually wrote, minus
  // the contract marker that GitHub's UI already renders as a badge.
  const remainingLines = [
    ...lines.slice(0, verdictIdx),
    ...lines.slice(verdictIdx + 1),
  ];
  const bodyWithoutVerdict = remainingLines.join("\n").trim();

  return { verdict: token, bodyWithoutVerdict };
}
