import { githubFetch } from './fetch.js';

export interface ReviewComment {
  path: string;
  line: number;
  side: 'RIGHT' | 'LEFT';
  body: string;
}

/** Result from posting a PR comment — includes the comment ID for reaction tracking. */
export interface PostedCommentResult {
  html_url: string;
  comment_id: number;
}

/** A reaction on a GitHub issue comment. */
export interface Reaction {
  user_id: number;
  content: string;
}

/**
 * Post a comment on a GitHub pull request.
 * Returns the html_url and comment_id of the created comment.
 */
export async function postPrComment(
  owner: string,
  repo: string,
  prNumber: number,
  body: string,
  token: string,
): Promise<PostedCommentResult> {
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

  const data = (await response.json()) as { html_url: string; id: number };
  return { html_url: data.html_url, comment_id: data.id };
}

/**
 * Fetch reactions on a GitHub issue comment.
 * Returns an array of { user_id, content } for each reaction.
 */
export async function getCommentReactions(
  owner: string,
  repo: string,
  commentId: number,
  token: string,
): Promise<Reaction[]> {
  const response = await githubFetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
    { token },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch comment reactions: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as Array<{
    user: { id: number };
    content: string;
  }>;

  return data.map((r) => ({ user_id: r.user.id, content: r.content }));
}
