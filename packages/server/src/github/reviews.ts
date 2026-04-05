import { githubFetch } from './fetch.js';

export interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT' | 'LEFT';
  body: string;
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

/** GitHub Pull Request Review event — maps 1:1 to ReviewVerdict (uppercased). */
export type PrReviewEvent = 'APPROVE' | 'REQUEST_CHANGES' | 'COMMENT';

/**
 * Submit a pull request review with an event (APPROVE / REQUEST_CHANGES / COMMENT).
 * Uses the GitHub Pull Request Reviews API so the verdict shows as a proper review status.
 * Returns the html_url of the created review.
 */
export async function postPrReview(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  event: PrReviewEvent,
  token: string,
): Promise<string> {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`,
    {
      method: 'POST',
      token,
      body: JSON.stringify({ body, event }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to post PR review: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { html_url: string };
  return data.html_url;
}
