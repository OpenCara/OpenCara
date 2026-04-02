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

/** Default age-out window: 30 days in milliseconds. */
export const DEFAULT_AGE_OUT_MS = 30 * 24 * 60 * 60 * 1000;

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

/** Result of ensureIndexComments — IDs and bodies for all 3 comments. */
export interface EnsuredIndex {
  openId: number;
  openBody: string;
  recentId: number;
  recentBody: string;
  archivedId: number;
  archivedBody: string;
}

/**
 * Ensure the 3 structured comments exist on the index issue.
 * Creates any missing ones and returns the comment IDs and current bodies.
 */
export async function ensureIndexComments(
  github: GitHubService,
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
  logger: Logger,
): Promise<EnsuredIndex> {
  const comments = await github.listIssueComments(owner, repo, issueNumber, token);
  const found = findIndexComments(comments);

  const openId =
    found.open?.id ??
    (await github.createIssueComment(owner, repo, issueNumber, OPEN_HEADER, token));
  const openBody = found.open?.body ?? OPEN_HEADER;
  const recentId =
    found.recent?.id ??
    (await github.createIssueComment(owner, repo, issueNumber, RECENT_HEADER, token));
  const recentBody = found.recent?.body ?? RECENT_HEADER;
  const archivedId =
    found.archived?.id ??
    (await github.createIssueComment(owner, repo, issueNumber, ARCHIVED_HEADER, token));
  const archivedBody = found.archived?.body ?? ARCHIVED_HEADER;

  if (!found.open || !found.recent || !found.archived) {
    logger.info('Created missing index comments', {
      issueNumber,
      createdOpen: !found.open,
      createdRecent: !found.recent,
      createdArchived: !found.archived,
    });
  }

  return { openId, openBody, recentId, recentBody, archivedId, archivedBody };
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
  const { openId, openBody } = await ensureIndexComments(
    github,
    owner,
    repo,
    issueNumber,
    token,
    logger,
  );

  const updatedBody = `${openBody}\n${entry}`;
  await github.updateIssueComment(owner, repo, openId, updatedBody, token);
}

// ── Entry parsing helpers ───────────────────────────────────────

/**
 * Extract the item number from an index entry line.
 * Matches patterns like `- #42 ...` or `- #42: ...`.
 * Returns null if the line doesn't match.
 */
export function parseEntryNumber(line: string): number | null {
  const match = line.match(/^-\s+#(\d+)\b/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Extract entries (non-header lines starting with `- #`) from a comment body.
 */
export function extractEntries(body: string): string[] {
  return body.split('\n').filter((line) => /^-\s+#\d+/.test(line.trim()));
}

/**
 * Remove a specific entry (by item number) from a comment body.
 * Returns the updated body and the removed entry line (or null if not found).
 */
export function removeEntry(
  body: string,
  itemNumber: number,
): { body: string; entry: string | null } {
  const lines = body.split('\n');
  let entry: string | null = null;
  const remaining = lines.filter((line) => {
    if (entry) return true; // already found — keep remaining
    const num = parseEntryNumber(line.trim());
    if (num === itemNumber) {
      entry = line.trim();
      return false;
    }
    return true;
  });
  return { body: remaining.join('\n'), entry };
}

/**
 * Parse an entry line into its components: number, labels, and description.
 * Entry format: `- #<number>(<labels>): <description>`
 * Returns null if the line doesn't match the expected format.
 */
export function parseEntry(
  line: string,
): { number: number; labels: string; description: string } | null {
  const match = line.match(/^-\s+#(\d+)\(([^)]*)\):\s*(.*)$/);
  if (!match) return null;
  return {
    number: parseInt(match[1], 10),
    labels: match[2],
    description: match[3],
  };
}

/**
 * Format an entry line from its components.
 */
export function formatEntryLine(itemNumber: number, labels: string, description: string): string {
  return `- #${itemNumber}(${labels}): ${description}`;
}

/**
 * Update an entry in the Open Items comment by item number.
 *
 * - Label changes: Always update the `(<labels>)` portion.
 * - Title changes: Only update the description if it currently matches the old title
 *   (i.e., it was not AI-enriched). If the description was AI-generated, leave it as-is.
 *
 * Returns without error if the entry is not found (no-op).
 */
export async function updateOpenEntry(
  github: GitHubService,
  owner: string,
  repo: string,
  indexIssueNumber: number,
  itemNumber: number,
  token: string,
  logger: Logger,
  update: {
    labels?: string[];
    newTitle?: string;
    oldTitle?: string;
  },
): Promise<void> {
  const ensured = await ensureIndexComments(github, owner, repo, indexIssueNumber, token, logger);

  const lines = ensured.openBody.split('\n');
  let found = false;

  const updatedLines = lines.map((line) => {
    if (found) return line;
    const parsed = parseEntry(line.trim());
    if (!parsed || parsed.number !== itemNumber) return line;

    found = true;

    // Update labels if provided
    const newLabels = update.labels !== undefined ? update.labels.join(', ') : parsed.labels;

    // Update description only if it matches the old title (not AI-enriched)
    let newDescription = parsed.description;
    if (update.newTitle && update.oldTitle && parsed.description === update.oldTitle) {
      newDescription = update.newTitle;
    }

    return formatEntryLine(itemNumber, newLabels, newDescription);
  });

  if (!found) {
    logger.info('Entry not found in Open Items — skipping update', {
      indexIssueNumber,
      itemNumber,
    });
    return;
  }

  const updatedBody = updatedLines.join('\n');
  await github.updateIssueComment(owner, repo, ensured.openId, updatedBody, token);

  logger.info('Entry updated in Open Items', {
    indexIssueNumber,
    itemNumber,
    updatedLabels: update.labels !== undefined,
    updatedTitle: update.newTitle !== undefined,
  });
}

// ── Close date annotation ───────────────────────────────────────

/**
 * Format a close-date suffix to append to entries in Recently Closed.
 * Uses ISO date (YYYY-MM-DD) for consistent parsing.
 */
export function formatCloseDate(timestamp: number): string {
  const d = new Date(timestamp);
  return d.toISOString().slice(0, 10); // YYYY-MM-DD
}

/**
 * Parse the close date from a Recently Closed entry line.
 * Expects the date in `(closed YYYY-MM-DD)` suffix.
 * Returns the timestamp (start of day UTC) or null if not found.
 */
export function parseCloseDate(line: string): number | null {
  const match = line.match(/\(closed (\d{4}-\d{2}-\d{2})\)/);
  return match ? new Date(match[1]).getTime() : null;
}

/**
 * Convert an entry to its compact archived format: `- #<number> — <title>`.
 * Strips labels, close-date annotations, and other metadata.
 */
export function toArchivedEntry(entry: string): string {
  // Extract number and description after labels/markers
  const match = entry.match(/^-\s+#(\d+)\b.*?—\s*(.+?)(?:\s*\(closed \d{4}-\d{2}-\d{2}\))?$/);
  if (match) {
    return `- #${match[1]} — ${match[2].trim()}`;
  }
  // Fallback: strip close-date annotation only
  return entry.replace(/\s*\(closed \d{4}-\d{2}-\d{2}\)/, '').trim();
}

// ── Lifecycle operations ────────────────────────────────────────

/**
 * Move an entry from Open Items → Recently Closed.
 * Appends a `(closed YYYY-MM-DD)` suffix to the entry.
 *
 * If the entry is not found in Open Items, this is a no-op (no error).
 */
export async function moveToRecentlyClosed(
  github: GitHubService,
  owner: string,
  repo: string,
  indexIssueNumber: number,
  itemNumber: number,
  token: string,
  logger: Logger,
  now: number = Date.now(),
): Promise<void> {
  const ensured = await ensureIndexComments(github, owner, repo, indexIssueNumber, token, logger);

  // Remove from Open
  const { body: newOpenBody, entry } = removeEntry(ensured.openBody, itemNumber);
  if (!entry) {
    logger.info('Entry not found in Open Items — skipping move', {
      indexIssueNumber,
      itemNumber,
    });
    return;
  }

  // Append to Recently Closed with close date
  const closedEntry = `${entry} (closed ${formatCloseDate(now)})`;
  const newRecentBody = `${ensured.recentBody}\n${closedEntry}`;

  // Update both comments
  await github.updateIssueComment(owner, repo, ensured.openId, newOpenBody, token);
  await github.updateIssueComment(owner, repo, ensured.recentId, newRecentBody, token);

  logger.info('Entry moved to Recently Closed', {
    indexIssueNumber,
    itemNumber,
    closeDate: formatCloseDate(now),
  });
}

/**
 * Age out entries from Recently Closed → Archived.
 * Entries older than `ageOutMs` (default 30 days) are moved.
 * Archived entries use compact format (number + title only).
 *
 * This can be called lazily during any index update.
 */
export async function ageOutToArchived(
  github: GitHubService,
  owner: string,
  repo: string,
  indexIssueNumber: number,
  token: string,
  logger: Logger,
  now: number = Date.now(),
  ageOutMs: number = DEFAULT_AGE_OUT_MS,
): Promise<void> {
  const ensured = await ensureIndexComments(github, owner, repo, indexIssueNumber, token, logger);

  const recentEntries = extractEntries(ensured.recentBody);
  const toArchive: string[] = [];
  const toKeep: string[] = [];

  for (const entry of recentEntries) {
    const closeDate = parseCloseDate(entry);
    if (closeDate !== null && now - closeDate >= ageOutMs) {
      toArchive.push(entry);
    } else {
      toKeep.push(entry);
    }
  }

  if (toArchive.length === 0) return;

  // Rebuild Recently Closed without aged-out entries
  const newRecentBody =
    toKeep.length > 0 ? `${RECENT_HEADER}\n${toKeep.join('\n')}` : RECENT_HEADER;

  // Append compact entries to Archived
  const archivedEntries = toArchive.map(toArchivedEntry);
  const newArchivedBody = `${ensured.archivedBody}\n${archivedEntries.join('\n')}`;

  await github.updateIssueComment(owner, repo, ensured.recentId, newRecentBody, token);
  await github.updateIssueComment(owner, repo, ensured.archivedId, newArchivedBody, token);

  logger.info('Entries aged out to Archived', {
    indexIssueNumber,
    count: toArchive.length,
    archivedNumbers: toArchive.map((e) => parseEntryNumber(e)),
  });
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
