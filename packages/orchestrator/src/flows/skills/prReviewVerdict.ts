import type { SkillEnvelope } from "../skills.js";

// Pure-markdown skill envelope injected into a reviewer agent's system
// prompt when its downstream graph contains a `scm.post_review`
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
//
// Beyond the verdict line, the skill sets the review's content rules. They
// follow the Claude Code team's write-up on agent code review
// (claude.dev/blog/solving-code-review-at-anthropic, 2026-10):
//   - findings are tagged Important / Nit / Pre-existing, so a bug the PR
//     didn't introduce doesn't read as the author's fault, and only
//     Important ones block;
//   - every finding carries file:line evidence, a class of bug is reported
//     once with all its locations, style-only findings are dropped and nits
//     are capped — noise costs a whole fix round when the author is an agent;
//   - the summary opens with a count and says plainly when there's nothing
//     to fix;
//   - a re-review covers what changed since the last review and never
//     repeats a posted finding (in their data most repeat flags were on
//     code the first pass had already seen);
//   - the synthesizer verifies the reviewers' findings instead of merging
//     them blindly — their version of verifier agents voting on findings.
//
// The verdict rules matter for the loop: `request_changes` and `comment`
// wake the pr-review-fix agent, `approve` doesn't. Nit-only reviews
// therefore approve, so a nit never costs an automatic fix round.

/** What the previous OpenCara review on this PR covered (see flows/priorReview.ts). */
export interface PrReviewVerdictPriorReview {
  /** Head commit the previous review was posted against (hex, validated). */
  headSha: string;
  verdict: string | null;
  htmlUrl: string | null;
}

export function buildPrReviewVerdictSkill(opts: {
  baseUrl: string;
  runId: string;
  /** `synthesizer` = this agent's input is other reviewers' output (fan-in). */
  role?: "reviewer" | "synthesizer";
  /** The previous OpenCara review on this PR, when there is one. */
  priorReview?: PrReviewVerdictPriorReview | null;
  /** True when the agent runs in a checkout of the PR head (can `git diff`). */
  hasCheckout?: boolean;
}): SkillEnvelope {
  const baseUrl = opts.baseUrl.replace(/\/$/, "");
  const role = opts.role ?? "reviewer";
  const sections = [
    INTRO,
    role === "synthesizer" ? SYNTHESIZER_ROLE : REVIEWER_ROLE,
    FINDING_RULES,
    OUTPUT_CONTRACT,
  ];
  if (opts.priorReview) {
    sections.push(reReviewSection(opts.priorReview, Boolean(opts.hasCheckout)));
  }
  sections.push(OUT_OF_SCOPE);
  const instructions = sections.join("\n\n");
  return {
    name: "opencara-pr-review-verdict",
    instructions,
    baseUrl,
    runId: opts.runId,
  };
}

const INTRO = `# Skill: opencara-pr-review-verdict

You are reviewing a pull request. Your output is posted to the PR as one
review through the platform's Reviews API, and its verdict decides what
happens next: \`request_changes\` and \`comment\` wake the fix agent,
\`approve\` does not. The fix agent acts on every finding it is given (one
more commit, one more review round), so post only what is worth that.`;

const REVIEWER_ROLE = `## What to look for

- Does the change do what the pull request says it does, fit the rest of
  the system, and leave everything else working? On a bug fix, check that
  it fixes the root cause, not a symptom.
- Read the code you comment on. Every finding needs evidence: a
  \`path:line\` in the PR's head and a concrete case that goes wrong (an
  input, a state, a sequence of calls). Don't guess from a name.`;

const SYNTHESIZER_ROLE = `## Your role: synthesizer

The input below holds independent reviews of this pull request by several
agents. Merge them into ONE review in the format below. Treat their
findings as claims to check, not conclusions:

- Keep a finding only if you can confirm it from the diff or code in front
  of you, or if at least two reviewers raised it independently. Drop the
  rest: a false alarm costs the author a whole fix round.
- Merge duplicates. Set each kept finding's severity on your own judgement;
  several reviewers calling something important doesn't make it so.
- Don't attribute findings to reviewers or summarise each review; the
  author needs one list.
- Your verdict follows from the findings you kept, not from the reviewers'
  verdicts.`;

const FINDING_RULES = `## Findings

Tag every finding with exactly one severity:

- **[Important]**: a bug or regression this PR introduces that should be
  fixed before merge.
- **[Nit]**: worth a look; doesn't block merge.
- **[Pre-existing]**: a real problem in code this PR didn't introduce.
  Reported so it isn't lost; never blocking and not the author's fault.

When the same problem appears in more than one place, report it once as a
class and list every location, so the author fixes all of them in one round.

Drop findings that are only about style, formatting, naming, comments,
logging or tidying up, unless they break a convention written down in the
repository's instructions file. Post at most 3 nits.`;

const OUTPUT_CONTRACT = `## Output contract

Begin your reply with **exactly one** line of the form:

- \`verdict: request_changes\`: at least one [Important] finding.
- \`verdict: approve\`: no [Important] finding ([Nit] or [Pre-existing]
  only, or nothing at all).
- \`verdict: comment\`: only when you could not complete the review; say
  why in the summary.

That single line MUST be the first non-blank line of your reply. It
must use the literal label \`verdict:\` (case-insensitive) followed by
exactly one of the three tokens above (case-insensitive).

The orchestrator strips this line from the body before posting the
review, so it does NOT appear inside the rendered review. Your verdict
instead drives the colored review badge ("Approved" / "Changes
requested" / "Commented") shown on the PR.

After the verdict line, leave a blank line and write the body in this
shape:

\`\`\`
## Summary

2 important · 1 nit · 0 pre-existing
One or two sentences: does the change do what it says?

## Findings

1. **[Important]** \`path/to/file.ts:42\`: what goes wrong, and when.
   Evidence: … Fix: …
2. **[Nit]** \`path/to/other.ts:7\`: …
\`\`\`

The summary's first line is the count. When there is nothing to fix, say
so plainly ("Nothing to fix.") and write \`None.\` under Findings.`;

function reReviewSection(prior: PrReviewVerdictPriorReview, hasCheckout: boolean): string {
  const sha = prior.headSha;
  const short = sha.slice(0, 12);
  const previous = [
    prior.verdict ? `verdict ${prior.verdict.toLowerCase()}` : null,
    prior.htmlUrl ? prior.htmlUrl : null,
  ]
    .filter(Boolean)
    .join(", ");
  const whereToLook = hasCheckout
    ? `- Review what changed since then: \`git diff ${sha}..HEAD\` in your
  checkout. If that commit is no longer in the history (a force-push or
  rebase), review the whole diff, but still apply the rules below.`
    : `- Your diff covers the whole PR, not just the new commits. Use the
  previous review to tell what was already covered.`;
  return `## This is a re-review

OpenCara already reviewed this pull request at commit \`${short}\`${previous ? ` (${previous})` : ""}.
That review's body is in your context as \`priorReview\`, and its commit is
in \`$OPENCARA_PR_LAST_REVIEWED_SHA\`.

${whereToLook}
- Never repeat a finding the previous review already posted. Instead, add a
  \`## Prior findings\` section between Summary and Findings with one line
  per earlier [Important] finding: \`Fixed\` or \`Still open\`, with the
  \`path:line\` that shows it. Don't put severity tags on those lines.
- An earlier [Important] finding that is still open counts toward the
  verdict: answer \`request_changes\` until every one is fixed, even when
  this pass finds nothing new.
- New findings belong on lines changed since \`${short}\`. Code the previous
  pass already saw is out of scope, unless it is an [Important] bug that
  would crash, lose data or open a security hole.`;
}

const OUT_OF_SCOPE = `## Out of scope today

Line-anchored review comments (per-file/per-line). Keep everything in this
one review body.`;
