import type { ReviewVerdict } from '@opencara/shared';
import type { ReviewComment } from './github.js';

export interface ParsedReview {
  summary: string;
  verdict: ReviewVerdict | null;
  comments: ReviewComment[];
}

/**
 * Extract changed file paths from a unified diff.
 */
export function parseDiffFiles(diffContent: string): Set<string> {
  const files = new Set<string>();
  for (const match of diffContent.matchAll(/^diff --git a\/(.+?) b\/(.+)$/gm)) {
    // Add both a/ and b/ paths to handle renames and new files
    if (match[1] !== 'dev/null') files.add(match[1]);
    if (match[2] !== 'dev/null') files.add(match[2]);
  }
  return files;
}

/**
 * Parse a structured markdown review into summary, verdict, and inline comments.
 *
 * Expected format:
 *   ## Summary
 *   [text]
 *
 *   ## Findings
 *   - **[severity]** `file:line` — description
 *
 *   ## Verdict
 *   APPROVE | REQUEST_CHANGES | COMMENT
 *
 * Falls back gracefully: if no structured sections found, returns full text as summary.
 */
export function parseStructuredReview(text: string): ParsedReview {
  const comments: ReviewComment[] = [];

  // Extract ## Verdict section
  const verdictMatch = text.match(/##\s*Verdict\s*\n+\s*(APPROVE|REQUEST_CHANGES|COMMENT)\b/im);
  const verdict: ReviewVerdict | null = verdictMatch
    ? (verdictMatch[1].toLowerCase() as ReviewVerdict)
    : null;

  // Extract ## Findings section and parse inline comments
  const findingsMatch = text.match(/##\s*Findings\s*\n([\s\S]*?)(?=\n##\s|\n*$)/i);
  if (findingsMatch) {
    const findingsBlock = findingsMatch[1];

    // Format 1 (single-agent): - **[severity]** `file:line` — description
    const listPattern = /^[-*]\s*\*?\*?\[(\w+)\]\*?\*?\s*`([^`]+?):(\d+)`\s*[-—–:]\s*(.+)/gm;
    for (const match of findingsBlock.matchAll(listPattern)) {
      const severity = match[1];
      const path = match[2];
      const line = parseInt(match[3], 10);
      const description = match[4].trim();
      if (isNaN(line)) continue;
      comments.push({
        path,
        line,
        side: 'RIGHT',
        body: `**[${severity}]** ${description}`,
      });
    }

    // Format 2 (synthesizer): ### [severity] `file:line` — Title\nbody text...
    // Split findings block by ### headings and parse each section
    const headingLinePattern =
      /^###\s*\[(\w+)\]\s*`([^`]+?):(\d+)`\s*[-—–:]\s*(.+)$/gm;
    let headingMatch;
    const headings: { severity: string; path: string; line: number; titleStart: string; endIdx: number }[] = [];
    while ((headingMatch = headingLinePattern.exec(findingsBlock)) !== null) {
      headings.push({
        severity: headingMatch[1],
        path: headingMatch[2],
        line: parseInt(headingMatch[3], 10),
        titleStart: headingMatch[4].trim(),
        endIdx: headingMatch.index + headingMatch[0].length,
      });
    }
    for (let i = 0; i < headings.length; i++) {
      const h = headings[i];
      if (isNaN(h.line)) continue;
      // Avoid duplicates if list pattern already captured this file:line
      if (comments.some((c) => c.path === h.path && c.line === h.line)) continue;
      // Body = everything from end of heading line to start of next heading (or end of block)
      const nextStart = i + 1 < headings.length
        ? findingsBlock.lastIndexOf('\n###', headings[i + 1].endIdx)
        : findingsBlock.length;
      const bodyAfterTitle = findingsBlock.slice(h.endIdx, nextStart).trim();
      const fullBody = bodyAfterTitle
        ? `${h.titleStart}\n${bodyAfterTitle}`
        : h.titleStart;
      comments.push({
        path: h.path,
        line: h.line,
        side: 'RIGHT',
        body: `**[${h.severity}]** ${fullBody}`,
      });
    }
  }

  // Extract ## Summary section for the review body
  const summaryMatch = text.match(/##\s*Summary\s*\n([\s\S]*?)(?=\n##\s)/i);
  const summary = summaryMatch ? summaryMatch[1].trim() : text;

  return { summary, verdict, comments };
}

/**
 * Filter comments to only those whose path exists in the diff.
 */
export function filterValidComments(
  comments: ReviewComment[],
  diffFiles: Set<string>,
): ReviewComment[] {
  return comments.filter((c) => diffFiles.has(c.path));
}
