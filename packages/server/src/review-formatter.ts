import type { ReviewVerdict } from '@opencara/shared';

const VERDICT_EMOJI: Record<ReviewVerdict, string> = {
  approve: '\u2705',
  request_changes: '\u274C',
  comment: '\uD83D\uDCAC',
};

/** A partial review collected before timeout. */
export interface TimeoutReview {
  model: string;
  tool: string;
  verdict: ReviewVerdict;
  review_text: string;
}

/**
 * Format a consolidated timeout comment containing all partial reviews
 * and the timeout message in a single GitHub comment.
 *
 * This is the only server-side formatter — normal reviews are pre-formatted
 * by the CLI and posted as-is.
 */
export function formatTimeoutComment(timeoutMinutes: number, reviews: TimeoutReview[]): string {
  const parts: string[] = ['## OpenCara Review', ''];

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
      parts.push(`### Review ${i + 1} — ${emoji} ${r.verdict} (\`${r.model}/${r.tool}\`)`);
      parts.push('');
      parts.push(r.review_text);
    }
  }

  parts.push('');
  parts.push('---');
  parts.push('<sub>Reviewed by <a href="https://github.com/apps/opencara">OpenCara</a></sub>');

  return parts.join('\n');
}
