import type { Env } from './env.js';

export interface GitHubReaction {
  id: number;
  user: { id: number; login: string };
  content: string; // "+1", "-1", "laugh", "confused", "heart", "hooray", "rocket", "eyes"
}

/**
 * Generate a JWT for GitHub App authentication.
 * The JWT is used to request installation access tokens.
 */
async function generateAppJwt(env: Env): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iat: now - 60, // issued at (60s in the past to allow clock drift)
    exp: now + 600, // expires in 10 minutes
    iss: env.GITHUB_APP_ID,
  };

  const enc = new TextEncoder();
  const headerB64 = base64url(enc.encode(JSON.stringify(header)));
  const payloadB64 = base64url(enc.encode(JSON.stringify(payload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const keyData = pemToArrayBuffer(env.GITHUB_APP_PRIVATE_KEY);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyData,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(signingInput));
  const signatureB64 = base64url(new Uint8Array(signature));

  return `${signingInput}.${signatureB64}`;
}

function pemToArrayBuffer(pem: string): ArrayBuffer {
  const lines = pem
    .replace(/-----BEGIN [\w ]+ KEY-----/, '')
    .replace(/-----END [\w ]+ KEY-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(lines);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

function base64url(data: Uint8Array): string {
  let binary = '';
  for (const byte of data) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * Get an installation access token for the GitHub App.
 */
export async function getInstallationToken(installationId: number, env: Env): Promise<string> {
  const jwt = await generateAppJwt(env);
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'OpenCrust-Worker',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to get installation token: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { token: string };
  return data.token;
}

/**
 * Fetch the .review.yml file from a repository at a specific ref.
 * Returns null if the file doesn't exist.
 */
export async function fetchReviewConfig(
  owner: string,
  repo: string,
  ref: string,
  token: string,
): Promise<string | null> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/contents/.review.yml?ref=${ref}`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github.raw+json',
        'User-Agent': 'OpenCrust-Worker',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch .review.yml: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

/**
 * Fetch the unified diff for a pull request.
 */
export async function fetchPrDiff(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<string> {
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.diff',
      'User-Agent': 'OpenCrust-Worker',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch PR diff: ${response.status} ${response.statusText}`);
  }

  return response.text();
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
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'OpenCrust-Worker',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ body }),
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to post PR comment: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as { html_url: string };
  return data.html_url;
}

/**
 * Extract the numeric comment ID from a GitHub comment URL.
 * Supports both HTML URLs (issuecomment-123) and API URLs (/comments/123).
 */
export function extractCommentId(commentUrl: string): number | null {
  // HTML URL format: https://github.com/{owner}/{repo}/pull/{pr}#issuecomment-{id}
  const htmlMatch = commentUrl.match(/#issuecomment-(\d+)$/);
  if (htmlMatch) return parseInt(htmlMatch[1], 10);

  // API URL format: https://api.github.com/repos/{owner}/{repo}/issues/comments/{id}
  const apiMatch = commentUrl.match(/\/comments\/(\d+)$/);
  if (apiMatch) return parseInt(apiMatch[1], 10);

  return null;
}

/**
 * Fetch reactions on a GitHub issue comment.
 * Returns all reactions (paginated up to 100 per page).
 */
export async function fetchCommentReactions(
  owner: string,
  repo: string,
  commentId: number,
  token: string,
): Promise<GitHubReaction[]> {
  const response = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}/reactions`,
    {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'OpenCrust-Worker',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Failed to fetch comment reactions: ${response.status} ${response.statusText}`);
  }

  return (await response.json()) as GitHubReaction[];
}
