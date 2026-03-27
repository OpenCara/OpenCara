import { Command } from 'commander';
import pc from 'picocolors';
import { parseOpenCaraConfig } from '@opencara/shared';
import type { OpenCaraConfig } from '@opencara/shared';
import { loadAuth } from '../auth.js';
import { icons } from '../logger.js';

// ── Constants ────────────────────────────────────────────────

/** Default window for "recently closed" items (in days). */
const DEFAULT_RECENT_DAYS = 30;

/** Per-page limit for GitHub API pagination. */
const PER_PAGE = 100;

/** Comment markers — must match server's dedup-index.ts. */
const OPEN_MARKER = '<!-- opencara-dedup-index:open -->';
const RECENT_MARKER = '<!-- opencara-dedup-index:recent -->';
const ARCHIVED_MARKER = '<!-- opencara-dedup-index:archived -->';

// ── Types ────────────────────────────────────────────────────

/** A PR or issue item from the GitHub API. */
export interface GitHubItem {
  number: number;
  title: string;
  state: string; // 'open' | 'closed'
  labels: Array<{ name: string }>;
  closed_at: string | null;
  merged_at?: string | null; // PRs only
  pull_request?: unknown; // present on issues endpoint if item is a PR
}

/** Parsed index comment structure. */
interface IndexComments {
  open: { id: number; body: string } | null;
  recent: { id: number; body: string } | null;
  archived: { id: number; body: string } | null;
}

/** Categorized items ready for index population. */
export interface CategorizedItems {
  open: GitHubItem[];
  recentlyClosed: GitHubItem[];
  archived: GitHubItem[];
}

/** Dependencies for dedup init — allows injection for testing. */
export interface DedupInitDeps {
  fetchFn?: typeof fetch;
  log?: (msg: string) => void;
  logError?: (msg: string) => void;
  loadAuthFn?: typeof loadAuth;
}

// ── GitHub API Helpers ───────────────────────────────────────

/**
 * Fetch a file from a GitHub repo via the Contents API.
 * Returns the decoded text content, or null if not found.
 */
export async function fetchRepoFile(
  owner: string,
  repo: string,
  path: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | null> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github.raw+json',
    },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} fetching ${path}`);
  return res.text();
}

/**
 * Fetch all PRs from a repo using pagination.
 * Returns items sorted by number.
 */
export async function fetchAllPRs(
  owner: string,
  repo: string,
  token: string,
  fetchFn: typeof fetch = fetch,
  log?: (msg: string) => void,
): Promise<GitHubItem[]> {
  const items: GitHubItem[] = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls?state=all&per_page=${PER_PAGE}&page=${page}&sort=created&direction=desc`;
    const res = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status} fetching PRs page ${page}`);

    const batch = (await res.json()) as GitHubItem[];
    items.push(...batch);

    if (log) log(`  Fetched ${items.length} PRs...`);

    if (batch.length < PER_PAGE) break;
    page++;
  }

  return items;
}

/**
 * Fetch all issues from a repo using pagination (excludes PRs).
 * The GitHub Issues API returns both issues and PRs — items with
 * `pull_request` field are filtered out.
 */
export async function fetchAllIssues(
  owner: string,
  repo: string,
  token: string,
  fetchFn: typeof fetch = fetch,
  log?: (msg: string) => void,
): Promise<GitHubItem[]> {
  const items: GitHubItem[] = [];
  let page = 1;

  while (true) {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues?state=all&per_page=${PER_PAGE}&page=${page}&sort=created&direction=desc`;
    const res = await fetchFn(url, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) throw new Error(`GitHub API error: ${res.status} fetching issues page ${page}`);

    const batch = (await res.json()) as GitHubItem[];
    // Filter out PRs (they appear in issues endpoint with pull_request field)
    const issuesOnly = batch.filter((item) => !item.pull_request);
    items.push(...issuesOnly);

    if (log) log(`  Fetched ${items.length} issues...`);

    if (batch.length < PER_PAGE) break;
    page++;
  }

  return items;
}

/**
 * Fetch comments on an issue.
 */
async function fetchIssueComments(
  owner: string,
  repo: string,
  issueNumber: number,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<Array<{ id: number; body: string }>> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100`;
  const res = await fetchFn(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
    },
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} fetching comments`);
  return (await res.json()) as Array<{ id: number; body: string }>;
}

/**
 * Create a comment on an issue. Returns the comment ID.
 */
async function createIssueComment(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<number> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  const res = await fetchFn(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} creating comment`);
  const data = (await res.json()) as { id: number };
  return data.id;
}

/**
 * Update a comment on an issue.
 */
async function updateIssueComment(
  owner: string,
  repo: string,
  commentId: number,
  body: string,
  token: string,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  const url = `https://api.github.com/repos/${owner}/${repo}/issues/comments/${commentId}`;
  const res = await fetchFn(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ body }),
  });
  if (!res.ok) throw new Error(`GitHub API error: ${res.status} updating comment`);
}

// ── Index Entry Formatting ───────────────────────────────────

/**
 * Format a single item as an index entry line.
 * Full format: `- #<number> [label1] [label2] — <title>`
 * Compact format (archived): `- #<number> — <title>`
 */
export function formatEntry(item: GitHubItem, compact: boolean = false): string {
  if (compact) {
    return `- #${item.number} — ${item.title}`;
  }
  const labels = item.labels.map((l) => `[${l.name}]`).join(' ');
  const labelPart = labels ? ` ${labels}` : '';
  return `- #${item.number}${labelPart} — ${item.title}`;
}

// ── Categorization ───────────────────────────────────────────

/**
 * Categorize items into open, recently closed, and archived buckets.
 */
export function categorizeItems(
  items: GitHubItem[],
  recentDays: number = DEFAULT_RECENT_DAYS,
  nowMs: number = Date.now(),
): CategorizedItems {
  const cutoff = nowMs - recentDays * 24 * 60 * 60 * 1000;

  const open: GitHubItem[] = [];
  const recentlyClosed: GitHubItem[] = [];
  const archived: GitHubItem[] = [];

  for (const item of items) {
    if (item.state === 'open') {
      open.push(item);
    } else if (item.closed_at && new Date(item.closed_at).getTime() >= cutoff) {
      recentlyClosed.push(item);
    } else {
      archived.push(item);
    }
  }

  return { open, recentlyClosed, archived };
}

// ── Comment Body Building ────────────────────────────────────

/** Parse existing entries from a comment body. Returns the set of #numbers already present. */
export function parseExistingNumbers(body: string): Set<number> {
  const numbers = new Set<number>();
  const regex = /^- #(\d+)/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    numbers.add(parseInt(match[1], 10));
  }
  return numbers;
}

/** Build comment body for a section, merging with existing entries. */
export function buildCommentBody(
  marker: string,
  header: string,
  items: GitHubItem[],
  existingBody: string | null,
  compact: boolean = false,
): string {
  const existingNumbers = existingBody ? parseExistingNumbers(existingBody) : new Set<number>();
  const newItems = items.filter((item) => !existingNumbers.has(item.number));

  // Preserve existing entries and append new ones
  let body = existingBody ?? `${marker}\n## ${header}\n`;
  for (const item of newItems) {
    body += `\n${formatEntry(item, compact)}`;
  }

  return body;
}

// ── Find Index Comments ──────────────────────────────────────

function findIndexComments(comments: Array<{ id: number; body: string }>): IndexComments {
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

// ── Core Init Logic ──────────────────────────────────────────

export interface InitIndexOptions {
  owner: string;
  repo: string;
  indexIssue: number;
  kind: 'prs' | 'issues';
  recentDays: number;
  dryRun: boolean;
  token: string;
  fetchFn?: typeof fetch;
  log?: (msg: string) => void;
}

/**
 * Initialize a dedup index by scanning existing items and populating
 * the 3 structured comments on the index issue.
 */
export async function initIndex(opts: InitIndexOptions): Promise<{
  openCount: number;
  recentCount: number;
  archivedCount: number;
  newEntries: number;
}> {
  const { owner, repo, indexIssue, kind, recentDays, dryRun, token } = opts;
  const fetchFn = opts.fetchFn ?? fetch;
  const log = opts.log ?? (() => {});

  // 1. Fetch all items
  log(`Scanning ${kind}...`);
  const items =
    kind === 'prs'
      ? await fetchAllPRs(owner, repo, token, fetchFn, log)
      : await fetchAllIssues(owner, repo, token, fetchFn, log);

  log(`${icons.info} Found ${items.length} ${kind}.`);

  // 2. Categorize
  const { open, recentlyClosed, archived } = categorizeItems(items, recentDays);

  log(
    `  ${open.length} open, ${recentlyClosed.length} recently closed, ${archived.length} archived`,
  );

  // 3. Fetch existing comments on the index issue
  const comments = await fetchIssueComments(owner, repo, indexIssue, token, fetchFn);
  const found = findIndexComments(comments);

  // 4. Build updated comment bodies (merging without duplicates)
  const openBody = buildCommentBody(OPEN_MARKER, 'Open Items', open, found.open?.body ?? null);
  const recentBody = buildCommentBody(
    RECENT_MARKER,
    'Recently Closed Items',
    recentlyClosed,
    found.recent?.body ?? null,
  );
  const archivedBody = buildCommentBody(
    ARCHIVED_MARKER,
    'Archived Items',
    archived,
    found.archived?.body ?? null,
    true, // compact format
  );

  // Count new entries
  const existingOpen = found.open ? parseExistingNumbers(found.open.body) : new Set<number>();
  const existingRecent = found.recent ? parseExistingNumbers(found.recent.body) : new Set<number>();
  const existingArchived = found.archived
    ? parseExistingNumbers(found.archived.body)
    : new Set<number>();

  const newOpen = open.filter((i) => !existingOpen.has(i.number)).length;
  const newRecent = recentlyClosed.filter((i) => !existingRecent.has(i.number)).length;
  const newArchived = archived.filter((i) => !existingArchived.has(i.number)).length;
  const newEntries = newOpen + newRecent + newArchived;

  if (dryRun) {
    log(`\n${icons.info} Dry run — would update index issue #${indexIssue}:`);
    log(`  Open Items: ${open.length} entries (${newOpen} new)`);
    log(`  Recently Closed: ${recentlyClosed.length} entries (${newRecent} new)`);
    log(`  Archived: ${archived.length} entries (${newArchived} new)`);
    return {
      openCount: open.length,
      recentCount: recentlyClosed.length,
      archivedCount: archived.length,
      newEntries,
    };
  }

  // 5. Create or update comments
  log(`Populating index issue #${indexIssue}...`);

  if (found.open) {
    await updateIssueComment(owner, repo, found.open.id, openBody, token, fetchFn);
  } else {
    await createIssueComment(owner, repo, indexIssue, openBody, token, fetchFn);
  }

  if (found.recent) {
    await updateIssueComment(owner, repo, found.recent.id, recentBody, token, fetchFn);
  } else {
    await createIssueComment(owner, repo, indexIssue, recentBody, token, fetchFn);
  }

  if (found.archived) {
    await updateIssueComment(owner, repo, found.archived.id, archivedBody, token, fetchFn);
  } else {
    await createIssueComment(owner, repo, indexIssue, archivedBody, token, fetchFn);
  }

  log(
    `${icons.success} Index populated: ${open.length} open, ${recentlyClosed.length} recent, ${archived.length} archived (${newEntries} new entries)`,
  );

  return {
    openCount: open.length,
    recentCount: recentlyClosed.length,
    archivedCount: archived.length,
    newEntries,
  };
}

// ── CLI Command ──────────────────────────────────────────────

/** Run `opencara dedup init` with injectable dependencies. */
export async function runDedupInit(
  options: { repo?: string; all?: boolean; dryRun?: boolean; days?: string },
  deps: DedupInitDeps = {},
): Promise<void> {
  const fetchFn = deps.fetchFn ?? fetch;
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const loadAuthFn = deps.loadAuthFn ?? loadAuth;

  // 1. Require authentication
  const auth = loadAuthFn();
  if (!auth || auth.expires_at <= Date.now()) {
    logError(`${icons.error} Not authenticated. Run: ${pc.cyan('opencara auth login')}`);
    process.exitCode = 1;
    return;
  }
  const token = auth.access_token;

  // 2. Parse --repo flag
  if (!options.repo) {
    logError(`${icons.error} --repo is required. Usage: opencara dedup init --repo owner/repo`);
    process.exitCode = 1;
    return;
  }
  const [owner, repo] = options.repo.split('/');
  if (!owner || !repo) {
    logError(`${icons.error} Invalid repo format. Expected: owner/repo`);
    process.exitCode = 1;
    return;
  }

  const recentDays = options.days ? parseInt(options.days, 10) : DEFAULT_RECENT_DAYS;
  if (isNaN(recentDays) || recentDays <= 0) {
    logError(`${icons.error} --days must be a positive number`);
    process.exitCode = 1;
    return;
  }

  // 3. Fetch .opencara.toml from the repo
  log(`Fetching .opencara.toml from ${options.repo}...`);
  const tomlContent = await fetchRepoFile(owner, repo, '.opencara.toml', token, fetchFn);
  if (!tomlContent) {
    logError(`${icons.error} No .opencara.toml found in ${options.repo}`);
    process.exitCode = 1;
    return;
  }

  const parsed = parseOpenCaraConfig(tomlContent);
  if ('error' in parsed) {
    logError(`${icons.error} Failed to parse .opencara.toml: ${parsed.error}`);
    process.exitCode = 1;
    return;
  }
  const config = parsed as OpenCaraConfig;

  // 4. Determine which indexes to initialize
  const targets: Array<{ kind: 'prs' | 'issues'; indexIssue: number }> = [];

  if (config.dedup?.prs?.indexIssue) {
    targets.push({ kind: 'prs', indexIssue: config.dedup.prs.indexIssue });
  }
  if (config.dedup?.issues?.indexIssue) {
    targets.push({ kind: 'issues', indexIssue: config.dedup.issues.indexIssue });
  }

  if (targets.length === 0) {
    logError(
      `${icons.error} No dedup index issues configured in .opencara.toml. Add [dedup.prs] or [dedup.issues] with index_issue.`,
    );
    process.exitCode = 1;
    return;
  }

  // If --all is not set, only initialize PR index (default)
  const filteredTargets = options.all
    ? targets
    : targets.filter((t) => t.kind === 'prs').slice(0, 1);

  if (filteredTargets.length === 0) {
    // --all not set and no PR index configured
    if (targets.some((t) => t.kind === 'issues')) {
      logError(
        `${icons.error} No PR dedup index configured. Use --all to initialize issue index, or add [dedup.prs] with index_issue.`,
      );
    } else {
      logError(`${icons.error} No dedup index issues configured in .opencara.toml.`);
    }
    process.exitCode = 1;
    return;
  }

  // 5. Initialize each target
  for (const target of filteredTargets) {
    log(`\n${pc.bold(`Initializing ${target.kind} dedup index (issue #${target.indexIssue})...`)}`);
    await initIndex({
      owner,
      repo,
      indexIssue: target.indexIssue,
      kind: target.kind,
      recentDays,
      dryRun: options.dryRun ?? false,
      token,
      fetchFn,
      log,
    });
  }
}

/** Create the `dedup` command group. */
export function dedupCommand(): Command {
  const dedup = new Command('dedup').description('Dedup index management');

  dedup
    .command('init')
    .description('Scan existing PRs/issues and populate dedup index')
    .requiredOption('--repo <owner/repo>', 'Target repository (e.g., OpenCara/OpenCara)')
    .option('--all', 'Initialize both PR and issue dedup indexes')
    .option('--dry-run', 'Show what would be done without making changes')
    .option('--days <number>', 'Recently closed window in days (default: 30)', '30')
    .action(async (options: { repo: string; all?: boolean; dryRun?: boolean; days?: string }) => {
      await runDedupInit(options);
    });

  return dedup;
}
