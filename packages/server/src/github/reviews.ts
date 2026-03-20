import type { ReviewVerdict } from '@opencara/shared';
import { githubFetch } from './fetch.js';

export type ReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

const VERDICT_TO_EVENT: Record<ReviewVerdict, ReviewEvent> = {
  approve: 'APPROVE',
  request_changes: 'REQUEST_CHANGES',
  comment: 'COMMENT',
};

export function verdictToReviewEvent(verdict: ReviewVerdict): ReviewEvent {
  return VERDICT_TO_EVENT[verdict];
}

export interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT' | 'LEFT';
  body: string;
}

/**
 * Post a PR review using the GitHub Pull Request Review API.
 * Optionally includes inline comments on specific file:line locations.
 * Returns the html_url of the created review.
 */
export async function postPrReview(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  event: ReviewEvent,
  token: string,
  comments?: ReviewComment[],
): Promise<string> {
  const payload: Record<string, unknown> = { body, event };
  if (comments && comments.length > 0) {
    payload.comments = comments;
  }

  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    {
      method: 'POST',
      token,
      body: JSON.stringify(payload),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to post PR review: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { html_url: string };
  return data.html_url;
}

/**
 * Post a comment on a GitHub pull request.
 * Returns the html_url of the created comment.
 */
export async function postPrComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  token: string,
): Promise<string> {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    {
      method: 'POST',
      token,
      body: JSON.stringify({ body }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to post PR comment: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { html_url: string };
  return data.html_url;
}
