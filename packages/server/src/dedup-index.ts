/**
 * Manages the structured 3-comment layout for dedup index issues.
 *
 * Comment 1: Open items — currently open PRs/issues
 * Comment 2: Recently closed items — closed within recent window
 * Comment 3: Archived closed items — older closed items (number + labels only)
 *
 * Each comment is identified by a magic header marker so the system can
 * find the right comment to update even if other comments exist.
 */
import type { GitHubService } from './github/service.js';
import type { Logger } from './logger.js';

// ── Comment markers ─────────────────────────────────────────────

export const OPEN_MARKER = '<!-- opencara-dedup-index:open -->';
export const RECENT_MARKER = '<!-- opencara-dedup-index:recent -->';
export const ARCHIVED_MARKER = '<!-- opencara-dedup-index:archived -->';

const OPEN_HEADER = `${OPEN_MARKER}\n## Open Items\n`;
const RECENT_HEADER = `${RECENT_MARKER}\n## Recently Closed Items\n`;
const ARCHIVED_HEADER = `${ARCHIVED_MARKER}\n## Archived Items\n`;

/** Parsed structured comments from the index issue. */
export interface IndexComments {
  open: { id: number; body: string } | null;
  recent: { id: number; body: string } | null;
  archived: { id: number; body: string } | null;
}

/**
 * Find the 3 structured comments on the index issue by their markers.
 * Returns null for any comment that doesn't exist yet.
 */
export function findIndexComments(comments: Array<{ id: number; body: string }>): IndexComments {
  let open: { id: number; body: string } | null = null;
  let recent: { id: number; body: string } | null = null;
  let archived: { id: number; body: string } | null = null;

  for (const c of comments) {
    if (c.body.includes(OPEN_MARKER)) open = c;
    else if (c.body.includes(RECENT_MARKER)) recent = c;
    else if (c.body.includes(ARCHIVED_MARKER)) archived = c;
  }

  return { open, recent, archived };
}

/**
 * Ensure the 3 structured comments exist on the index issue.
 * Creates any missing ones and returns the comment IDs.
 */
export async function ensureIndexComments(
  github: GitHubService,
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
  logger: Logger,
): Promise<{ openId: number; recentId: number; archivedId: number }> {
  const comments = await github.listIssueComments(owner, repo, issueNumber, token);
  const found = findIndexComments(comments);

  const openId =
    found.open?.id ??
    (await github.createIssueComment(owner, repo, issueNumber, OPEN_HEADER, token));
  const recentId =
    found.recent?.id ??
    (await github.createIssueComment(owner, repo, issueNumber, RECENT_HEADER, token));
  const archivedId =
    found.archived?.id ??
    (await github.createIssueComment(owner, repo, issueNumber, ARCHIVED_HEADER, token));

  if (!found.open || !found.recent || !found.archived) {
    logger.info('Created missing index comments', {
      issueNumber,
      createdOpen: !found.open,
      createdRecent: !found.recent,
      createdArchived: !found.archived,
    });
  }

  return { openId, recentId, archivedId };
}

/**
 * Append an index entry to the Open Items comment.
 */
export async function appendOpenEntry(
  github: GitHubService,
  owner: string,
  repo: string,
  issueNumber: number,
  entry: string,
  token: string,
  logger: Logger,
): Promise<void> {
  const { openId } = await ensureIndexComments(github, owner, repo, issueNumber, token, logger);

  const comments = await github.listIssueComments(owner, repo, issueNumber, token);
  const openComment = comments.find((c) => c.id === openId);
  const currentBody = openComment?.body ?? OPEN_HEADER;

  const updatedBody = `${currentBody}\n${entry}`;
  await github.updateIssueComment(owner, repo, openId, updatedBody, token);
}

/**
 * Build a combined index body from all 3 comments for use in the dedup prompt.
 * Returns all entries concatenated so the AI sees the full index.
 */
export function buildIndexBody(index: IndexComments): string {
  const parts: string[] = [];

  if (index.open?.body) {
    parts.push(stripMarker(index.open.body, OPEN_MARKER));
  }
  if (index.recent?.body) {
    parts.push(stripMarker(index.recent.body, RECENT_MARKER));
  }
  if (index.archived?.body) {
    parts.push(stripMarker(index.archived.body, ARCHIVED_MARKER));
  }

  return parts.join('\n').trim() || '';
}

/** Strip the HTML comment marker from a comment body for cleaner prompt context. */
function stripMarker(body: string, marker: string): string {
  return body.replace(marker, '').trim();
}

/**
 * Fetch the index body from the 3 structured comments on the index issue.
 * Returns empty string if no index comments exist.
 * Used by the poll route to populate index_issue_body.
 */
export async function fetchIndexBody(
  github: GitHubService,
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
): Promise<string> {
  const comments = await github.listIssueComments(owner, repo, issueNumber, token);
  const index = findIndexComments(comments);
  return buildIndexBody(index);
}
