import type { ReviewVerdict } from '@opencara/shared';

const REVIEW_HEADER = '## OpenCara Review';
const REVIEW_FOOTER =
  '<sub>Reviewed by <a href="https://github.com/apps/opencara">OpenCara</a></sub>';

const VERDICT_EMOJI: Record<ReviewVerdict, string> = {
  approve: '\u2705',
  request_changes: '\u274C',
  comment: '\uD83D\uDCAC',
};

/** A partial review collected before timeout. */
export interface TimeoutReview {
  model: string;
  tool: string;
  thinking?: string;
  verdict: ReviewVerdict;
  review_text: string;
}

/**
 * Wrap review text with the standard OpenCara header and footer.
 * Used for normal review comments posted to GitHub.
 * If contributors are provided, adds "Contributors: @user1, @user2" to the header.
 */
export function wrapReviewComment(reviewText: string, contributors?: string[]): string {
  const contributorLine =
    contributors && contributors.length > 0
      ? `\n**Contributors**: ${contributors.map((c) => `@${c}`).join(', ')}\n`
      : '';
  return `${REVIEW_HEADER}\n${contributorLine}\n${reviewText}\n\n---\n${REVIEW_FOOTER}`;
}

/**
 * Format a consolidated timeout comment containing all partial reviews
 * and the timeout message in a single GitHub comment.
 */
export function formatTimeoutComment(timeoutMinutes: number, reviews: TimeoutReview[]): string {
  const parts: string[] = [REVIEW_HEADER, ''];

  if (reviews.length === 0) {
    parts.push(`> Review timed out after ${timeoutMinutes} minutes.`);
  } else {
    parts.push(
      `> Review timed out after ${timeoutMinutes} minutes. ${reviews.length} partial review(s) collected.`,
    );

    for (let i = 0; i < reviews.length; i++) {
      const r = reviews[i];
      const emoji = VERDICT_EMOJI[r.verdict];
      parts.push('');
      parts.push('---');
      const thinkingSuffix = r.thinking ? `, thinking: ${r.thinking}` : '';
      parts.push(
        `### Review ${i + 1} — ${emoji} ${r.verdict} (\`${r.model}/${r.tool}\`${thinkingSuffix})`,
      );
      parts.push('');
      parts.push(r.review_text);
    }
  }

  parts.push('');
  parts.push('---');
  parts.push(REVIEW_FOOTER);

  return parts.join('\n');
}
