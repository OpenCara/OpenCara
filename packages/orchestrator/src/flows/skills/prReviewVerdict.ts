import type { SkillEnvelope } from "../skills.js";

// Pure-markdown skill envelope injected into a reviewer agent's system
// prompt when its downstream graph contains a `github.post_review`
// action node. The instruction forces the verdict-line contract that
// the post-review parser (agents/verdict.ts) reads to populate
// GitHub's review `event` enum (APPROVE / REQUEST_CHANGES / COMMENT).
//
// Auto-injection happens transitively: in fan-in flows like
// `pr-review-multi`, every reviewer that feeds the synthesizer (which
// in turn feeds the post-review node) also gets the skill, so each
// reviewer's stdout begins with its own verdict line. The synthesizer
// treats those upstream verdicts as input signal and emits its own
// final verdict line — only the synthesizer's output is what the
// post-review node actually parses.
export function buildPrReviewVerdictSkill(opts: {
  baseUrl: string;
  runId: string;
}): SkillEnvelope {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const instructions = `# Skill: opencara-pr-review-verdict

You are reviewing a pull request and your output will be posted to
GitHub via the Reviews API.

## Output contract

Begin your reply with **exactly one** line of the form:

- \`verdict: approve\` — when the diff is good to merge as-is.
- \`verdict: request_changes\` — when blocking issues exist that the
  author must address before merge.
- \`verdict: comment\` — for non-blocking observations or drive-by
  feedback that doesn't gate merge.

That single line MUST be the first non-blank line of your reply. It
must use the literal label \`verdict:\` (case-insensitive) followed by
exactly one of the three tokens above (case-insensitive).

The orchestrator strips this line from the body before posting the
review on GitHub, so it does NOT appear inside the rendered review.
Your verdict instead drives the colored review badge ("Approved" /
"Changes requested" / "Commented") that GitHub shows on the PR.

## Body

After the verdict line, leave a blank line and write the review body
as normal markdown. This is what reviewers and the PR author will
read. Be concrete: name files, line ranges, and the specific change
you'd like to see.

## Out of scope today

Line-anchored review comments (per-file/per-line). Stick to a single
prose body for now.
`;
  return {
    name: "opencara-pr-review-verdict",
    instructions,
    baseUrl,
    runId: opts.runId,
  };
}
