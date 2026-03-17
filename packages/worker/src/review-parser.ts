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
  for (const match of diffContent.matchAll(/^diff --git a\/(.+?) b\//gm)) {
    files.add(match[1]);
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
    // Pattern: - **[severity]** `file:line` — description
    const findingPattern = /^[-*]\s*\*?\*?\[(\w+)\]\*?\*?\s*`([^`]+?):(\d+)`\s*[-—–:]\s*(.+)/gm;
    for (const match of findingsBlock.matchAll(findingPattern)) {
      const severity = match[1];
      const path = match[2];
      const line = parseInt(match[3], 10);
      const description = match[4].trim();
      comments.push({
        path,
        line,
        body: `**[${severity}]** ${description}`,
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
