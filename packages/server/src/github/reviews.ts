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
