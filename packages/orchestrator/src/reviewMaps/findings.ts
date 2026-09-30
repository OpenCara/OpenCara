/**
 * Map review prose onto the files it mentions. Reviewers write
 * "packages/foo/bar.ts:12 has a race" or "- `src/util.py` leaks a handle";
 * the scan looks for each changed file's full path (with an optional line
 * anchor) and — when unambiguous — its basename, then attaches the cleaned
 * line as a finding with a severity guessed from the line and the nearest
 * preceding markdown heading.
 */

import type { ReviewMapFinding, ReviewMapSeverity } from "@opencara/shared";

const MAX_FINDING_TEXT = 300;

// "-level" lookahead so "high-level summary" / "low-level detail" don't
// read as severity markers.
const SEVERITY_RULES: [ReviewMapSeverity, RegExp][] = [
  ["high", /\b(?:critical|blocker|blocking|high(?!-level))\b/i],
  ["medium", /\b(?:medium|major)\b/i],
  ["low", /\b(?:low(?!-level)|minor|nits?|nitpicks?)\b/i],
];

// A file named inside a "what changed" section is being described, not
// flagged — recording it as a finding invents a problem the review never
// raised.
const SUMMARY_HEADING_RE =
  /^(?:summary|overview|changes|changed files|files changed|what changed)\b/i;

function severityOf(text: string): ReviewMapSeverity {
  for (const [sev, re] of SEVERITY_RULES) {
    if (re.test(text)) return sev;
  }
  return "info";
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function baseOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? path : path.slice(i + 1);
}

/** Strip the markdown noise around a line so it reads as plain text. */
function cleanLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "") // bullet markers
    .replace(/`/g, "")
    .replace(/[*_]{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_FINDING_TEXT);
}

// Optional trailing location: `:12`, `:12-20`, `:L12`, `#L12`, `#L12-L20`.
const LINE_ANCHOR = String.raw`(?:(?:#|:)L?(\d+)(?:-L?(\d+))?)?`;

const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/;

interface FileMatcher {
  path: string;
  re: RegExp;
}

/**
 * Extract per-file findings from a review body. `files` are the PR's changed
 * paths. Returns a Map keyed by path — files never mentioned are absent.
 */
export function extractFindings(
  reviewMarkdown: string,
  files: { path: string }[],
): Map<string, ReviewMapFinding[]> {
  // A basename matcher is only safe when it identifies exactly one changed
  // file and actually looks like a filename (has an extension).
  const basenameCount = new Map<string, number>();
  for (const f of files) {
    const b = baseOf(f.path);
    basenameCount.set(b, (basenameCount.get(b) ?? 0) + 1);
  }

  const matchers: FileMatcher[] = files.map((f) => {
    const alternates = [escapeRe(f.path)];
    const b = baseOf(f.path);
    if (basenameCount.get(b) === 1 && /\.\w+$/.test(b)) {
      alternates.push(escapeRe(b));
    }
    // The lookbehind stops a basename alternate from matching inside a longer
    // path (e.g. `bar.ts` inside `baz/bar.ts` or `other-bar.ts`).
    const re = new RegExp(
      `(?<![\\w/.-])(?:${alternates.join("|")})${LINE_ANCHOR}`,
    );
    return { path: f.path, re };
  });

  const out = new Map<string, ReviewMapFinding[]>();
  let heading = "";
  let underSummaryHeading = false;

  for (const rawLine of reviewMarkdown.split("\n")) {
    const hm = rawLine.match(HEADING_RE);
    if (hm) {
      heading = cleanLine(hm[1]!);
      underSummaryHeading = SUMMARY_HEADING_RE.test(heading);
    }
    if (underSummaryHeading) continue;
    for (const { path, re } of matchers) {
      const m = re.exec(rawLine);
      if (!m) continue;
      const line = m[1] !== undefined ? Number(m[1]) : undefined;
      const endLine = m[2] !== undefined ? Number(m[2]) : undefined;
      const text = cleanLine(rawLine);
      if (!text) continue;
      // The line's own wording wins; the enclosing heading is the fallback.
      const lineSeverity = severityOf(rawLine);
      const severity = lineSeverity !== "info" ? lineSeverity : severityOf(heading);
      const list = out.get(path) ?? [];
      if (list.some((f) => f.text === text)) continue;
      list.push({
        ...(line !== undefined ? { line } : {}),
        ...(endLine !== undefined ? { endLine } : {}),
        text,
        severity,
      });
      out.set(path, list);
    }
  }
  return out;
}
