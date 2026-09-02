// Reviewer-agent verdict contract: when an agent's output flows into a
// `scm.post_review` action node, the orchestrator injects a skill
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
//
// Line rule (relaxed 2026-09): a marker alone on its line still wins, but
// when no such line exists the parser falls back to an inline scan.
// Streaming adapters concatenate an agent's text segments around tool
// calls without newlines, so a posted review read
// "…before writing the verdict.verdict: request_changes" — the strict
// line-anchored match missed it, the review fell back to GitHub's raw
// `commented` state, and the review→fix trigger fired on the wrong intent
// (flow_run_id=01M1GWKV0F4AGJRGP93RBSK5SW). Markdown emphasis around the
// label or token (`**verdict:** approve`, `` `verdict: comment` ``) is
// tolerated on both passes.
//
// Why two passes and not one inline scan: the reviewer skill prompt lists
// the three markers in backticks, and agents quote it ("emit `verdict:
// approve` when clean"). A single first-match inline scan would let that
// quote outrank the real standalone verdict further down.
export type ReviewVerdict = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";

// Between label and token: one character class, never two adjacent
// unbounded quantifiers — `\s*[*_`]*\s*` backtracks quadratically on a
// long run of spaces, and this runs on raw webhook review bodies.
const TOKEN = "(approve|request_changes|comment)";
const STANDALONE_RE = new RegExp(`^[*_\`]*verdict[*_\`]*:[\\s*_\`]*${TOKEN}[*_\`]*$`, "i");
// (^|non-word) keeps `myverdict:` from matching; the lookahead keeps
// `approved` / `commentary` from matching the strict token.
const INLINE_RE = new RegExp(
  `(^|[^A-Za-z0-9_])([*_\`]*verdict[*_\`]*:[\\s*_\`]*${TOKEN}[*_\`]*)(?=$|[\\s.,;:!?)\\]])`,
  "i",
);

export interface ParsedReviewVerdict {
  verdict: ReviewVerdict;
  bodyWithoutVerdict: string;
}

export function parseReviewVerdict(body: string): ParsedReviewVerdict | null {
  if (!body) return null;

  // Normalize CRLF so the line walker behaves identically across editors.
  const normalized = body.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");

  // Pass 1: a line that is nothing but the marker. First one wins — a
  // reviewer that writes two standalone verdicts is a contract violation
  // we've observed exactly never. The whole line is dropped.
  for (let i = 0; i < lines.length; i++) {
    const m = STANDALONE_RE.exec(lines[i]!.trim());
    if (m) {
      return {
        // The regex group is constrained to the three canonical tokens;
        // the cast stays exhaustive as long as the alternation matches
        // the ReviewVerdict union.
        verdict: m[1]!.toUpperCase() as ReviewVerdict,
        bodyWithoutVerdict: [...lines.slice(0, i), ...lines.slice(i + 1)].join("\n").trim(),
      };
    }
  }

  // Pass 2: the marker glued into a line of prose. Only the marker (plus a
  // single trailing punctuation mark it was attached to) is removed; the
  // rest of the line stays so the operator sees what the agent wrote.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const m = INLINE_RE.exec(line);
    if (!m) continue;
    const start = m.index + m[1]!.length;
    const end = start + m[2]!.length;
    const stripped = tidySeam(line.slice(0, start), line.slice(end));
    return {
      verdict: m[3]!.toUpperCase() as ReviewVerdict,
      bodyWithoutVerdict: [
        ...lines.slice(0, i),
        ...(stripped.length > 0 ? [stripped] : []),
        ...lines.slice(i + 1),
      ]
        .join("\n")
        .trim(),
    };
  }
  return null;
}

/** Join the text either side of a removed inline marker without leaving
 *  doubled spaces or a dangling ". ." behind. */
function tidySeam(before: string, after: string): string {
  const rest = after.replace(/^[.,;:!?]/, "");
  return `${before.replace(/\s+$/, "")} ${rest.replace(/^\s+/, "")}`
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// Maps an agent's verdict token onto the value GitHub's
// `pull_request_review.review.state` carries when the review is rendered as
// that verdict. Used in two places that need to recover intent from a posted
// review body:
//   - `buildPullRequestContext` overrides OPENCARA_REVIEW_STATE so the
//     pr-review-fix agent sees "changes_requested" even when the actual
//     posted review was downgraded to COMMENT (see self-review fallback
//     in flows/nodeRunners.ts `scm.post_review`).
//   - `pullRequestReviewTrigger` uses the resolved state for its
//     `reviewStates` gate, so operators filter on intent rather than on
//     GitHub's badge.
export const VERDICT_TO_REVIEW_STATE: Record<ReviewVerdict, string> = {
  APPROVE: "approved",
  REQUEST_CHANGES: "changes_requested",
  COMMENT: "commented",
};

export interface ResolvedReviewState {
  state: string;
  verdict: ReviewVerdict;
  body: string;
}

/**
 * Inspect a review body for a `verdict: <token>` line. When present, return
 * the effective review state (verdict → GitHub state string) and the body
 * stripped of the contract marker. When absent, return null — callers
 * should fall back to GitHub's raw `review.state` and the verbatim body.
 */
export function resolveReviewStateFromBody(
  body: string | null | undefined,
): ResolvedReviewState | null {
  const parsed = parseReviewVerdict(body ?? "");
  if (!parsed) return null;
  return {
    state: VERDICT_TO_REVIEW_STATE[parsed.verdict],
    verdict: parsed.verdict,
    body: parsed.bodyWithoutVerdict,
  };
}
