import { execFileSync } from 'node:child_process';
import { Command } from 'commander';
import pc from 'picocolors';
import { parseOpenCaraConfig } from '@opencara/shared';
import type { OpenCaraConfig } from '@opencara/shared';
import { loadConfig } from '../config.js';
import { getToolDef, loadToolDefs } from '../tool-defs.js';
import { executeTool, type ToolExecutorResult } from '../tool-executor.js';
import { extractJson } from '../dedup.js';
import { icons } from '../logger.js';
import { buildIndexEntryPrompt } from '../prompts.js';
export { buildIndexEntryPrompt };

// ── Constants ────────────────────────────────────────────────

/** Default window for "recently closed" items (in days). */
const DEFAULT_RECENT_DAYS = 30;

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

/** Type for the injected gh CLI executor — allows mocking in tests. */
export type ExecGhFn = (args: string[]) => string;

/** Default gh CLI executor using execFileSync. */
export function defaultExecGh(args: string[]): string {
  return execFileSync('gh', args, {
    encoding: 'utf-8',
    timeout: 30_000,
    maxBuffer: 50 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** Dependencies for dedup init — allows injection for testing. */
export interface DedupInitDeps {
  execGh?: ExecGhFn;
  log?: (msg: string) => void;
  logError?: (msg: string) => void;
  resolveAgentCommandFn?: (toolName: string) => string | null;
  runTool?: (
    commandTemplate: string,
    prompt: string,
    timeoutMs: number,
  ) => Promise<ToolExecutorResult>;
}

// ── GitHub API Helpers (via gh CLI) ─────────────────────────

/**
 * Fetch a file from a GitHub repo via `gh api`.
 * Returns the decoded text content, or null if not found.
 */
export function fetchRepoFile(
  owner: string,
  repo: string,
  path: string,
  execGh: ExecGhFn = defaultExecGh,
): string | null {
  try {
    return execGh([
      'api',
      `repos/${owner}/${repo}/contents/${path}`,
      '-H',
      'Accept: application/vnd.github.raw+json',
    ]);
  } catch (err) {
    const message = String((err as { stderr?: string }).stderr ?? err);
    if (message.includes('404') || message.includes('Not Found')) return null;
    throw new Error(`gh API error fetching ${path}: ${message}`);
  }
}

/**
 * Fetch all PRs from a repo using `gh pr list --json`.
 * Returns items as GitHubItem[].
 */
export function fetchAllPRs(
  owner: string,
  repo: string,
  execGh: ExecGhFn = defaultExecGh,
  log?: (msg: string) => void,
): GitHubItem[] {
  const output = execGh([
    'pr',
    'list',
    '--repo',
    `${owner}/${repo}`,
    '--state',
    'all',
    '--limit',
    '9999',
    '--json',
    'number,title,state,labels,closedAt,mergedAt',
  ]);
  const raw = JSON.parse(output) as Array<{
    number: number;
    title: string;
    state: string;
    labels: Array<{ name: string }>;
    closedAt: string;
    mergedAt: string;
  }>;
  const items: GitHubItem[] = raw.map((pr) => ({
    number: pr.number,
    title: pr.title,
    state: pr.state === 'MERGED' ? 'closed' : pr.state.toLowerCase(),
    labels: pr.labels,
    closed_at: pr.closedAt || null,
    merged_at: pr.mergedAt || null,
  }));
  if (log) log(`  Fetched ${items.length} PRs...`);
  return items;
}

/**
 * Fetch all issues from a repo using `gh issue list --json`.
 * Returns only issues (not PRs) as GitHubItem[].
 */
export function fetchAllIssues(
  owner: string,
  repo: string,
  execGh: ExecGhFn = defaultExecGh,
  log?: (msg: string) => void,
): GitHubItem[] {
  const output = execGh([
    'issue',
    'list',
    '--repo',
    `${owner}/${repo}`,
    '--state',
    'all',
    '--limit',
    '9999',
    '--json',
    'number,title,state,labels,closedAt',
  ]);
  const raw = JSON.parse(output) as Array<{
    number: number;
    title: string;
    state: string;
    labels: Array<{ name: string }>;
    closedAt: string;
  }>;
  const items: GitHubItem[] = raw.map((issue) => ({
    number: issue.number,
    title: issue.title,
    state: issue.state.toLowerCase(),
    labels: issue.labels,
    closed_at: issue.closedAt || null,
  }));
  if (log) log(`  Fetched ${items.length} issues...`);
  return items;
}

/**
 * Fetch comments on an issue via `gh api --paginate`.
 */
function fetchIssueComments(
  owner: string,
  repo: string,
  issueNumber: number,
  execGh: ExecGhFn = defaultExecGh,
): Array<{ id: number; body: string }> {
  const output = execGh([
    'api',
    '--paginate',
    `repos/${owner}/${repo}/issues/${issueNumber}/comments`,
  ]);
  return JSON.parse(output) as Array<{ id: number; body: string }>;
}

/**
 * Create a comment on an issue via `gh issue comment`. Returns the comment ID.
 */
function createIssueComment(
  owner: string,
  repo: string,
  issueNumber: number,
  body: string,
  execGh: ExecGhFn = defaultExecGh,
): number {
  const output = execGh([
    'api',
    `repos/${owner}/${repo}/issues/${issueNumber}/comments`,
    '-X',
    'POST',
    '-f',
    `body=${body}`,
    '--jq',
    '.id',
  ]);
  return parseInt(output.trim(), 10);
}

/**
 * Update a comment on an issue via `gh api -X PATCH`.
 */
function updateIssueComment(
  owner: string,
  repo: string,
  commentId: number,
  body: string,
  execGh: ExecGhFn = defaultExecGh,
): void {
  execGh([
    'api',
    `repos/${owner}/${repo}/issues/comments/${commentId}`,
    '-X',
    'PATCH',
    '-f',
    `body=${body}`,
  ]);
}

// ── Index Entry Formatting ───────────────────────────────────

/**
 * Format a single item as an index entry line.
 * Full format: `- <number>(<label1>, <label2>): <title>`
 * Compact format (archived): `- <number>(): <title>`
 */
export function formatEntry(item: GitHubItem, compact: boolean = false): string {
  if (compact) {
    return `- ${item.number}(): ${item.title}`;
  }
  const labels = item.labels.map((l) => l.name).join(', ');
  return `- ${item.number}(${labels}): ${item.title}`;
}

// ── Agent-based Entry Generation ─────────────────────────────

/** Timeout per AI call for index entry generation (60s). */
const AI_ENTRY_TIMEOUT_MS = 60_000;

/**
 * Parse the AI response for an index entry description.
 * Returns the description string, or null if parsing fails.
 */
export function parseIndexEntryResponse(stdout: string): string | null {
  const jsonStr = extractJson(stdout);
  if (!jsonStr) return null;

  try {
    const parsed = JSON.parse(jsonStr) as Record<string, unknown>;
    if (typeof parsed.description === 'string' && parsed.description.length > 0) {
      return parsed.description;
    }
  } catch {
    // fall through
  }
  return null;
}

/**
 * Resolve a command template for a tool name.
 *
 * Priority:
 * 1. Matching agent in user's config (by tool name) — uses agent.command or global agentCommand
 * 2. Tool definition from tools/*.toml (with MODEL placeholder filled from default model)
 *
 * Returns null if the tool is not found anywhere.
 */
export function resolveAgentCommand(toolName: string): string | null {
  // 1. Check user config for a matching agent
  const config = loadConfig();
  if (config.agents) {
    const agent = config.agents.find((a) => a.tool === toolName);
    if (agent) {
      const cmd = agent.command ?? config.agentCommand;
      if (cmd) return cmd;
    }
  }

  // 2. Fall back to tool definition
  const toolDef = getToolDef(toolName);
  if (toolDef) {
    const modelName = toolDef.models[0] ?? '';
    return toolDef.command.replaceAll('${MODEL}', modelName);
  }

  return null;
}

/**
 * Generate an AI-enriched index entry for a single item.
 * Returns the enriched description on success, or null on failure.
 */
export async function generateAIEntry(
  item: GitHubItem,
  kind: 'prs' | 'issues',
  commandTemplate: string,
  runTool: (
    commandTemplate: string,
    prompt: string,
    timeoutMs: number,
  ) => Promise<ToolExecutorResult> = executeTool,
): Promise<string | null> {
  const prompt = buildIndexEntryPrompt(item, kind);
  try {
    const result = await runTool(commandTemplate, prompt, AI_ENTRY_TIMEOUT_MS);
    return parseIndexEntryResponse(result.stdout);
  } catch {
    return null;
  }
}

/**
 * Format a single item as an index entry line, using an AI-generated description if available.
 */
export function formatEntryWithDescription(
  item: GitHubItem,
  description: string,
  compact: boolean = false,
): string {
  if (compact) {
    return `- ${item.number}(): ${description}`;
  }
  const labels = item.labels.map((l) => l.name).join(', ');
  return `- ${item.number}(${labels}): ${description}`;
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

/** Parse existing entries from a comment body. Returns the set of numbers already present.
 *  Supports both old format (`- #42 ...`) and new format (`- 42(...): ...`).
 */
export function parseExistingNumbers(body: string): Set<number> {
  const numbers = new Set<number>();
  const regex = /^- #?(\d+)/gm;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(body)) !== null) {
    numbers.add(parseInt(match[1], 10));
  }
  return numbers;
}

/** Build comment body for a section, merging with existing entries.
 *  When `descriptions` is provided, uses AI-generated descriptions instead of raw titles.
 */
export function buildCommentBody(
  marker: string,
  header: string,
  items: GitHubItem[],
  existingBody: string | null,
  compact: boolean = false,
  descriptions?: Map<number, string>,
): string {
  const existingNumbers = existingBody ? parseExistingNumbers(existingBody) : new Set<number>();
  const newItems = items.filter((item) => !existingNumbers.has(item.number));

  // Preserve existing entries and append new ones
  let body = existingBody ?? `${marker}\n## ${header}\n`;
  for (const item of newItems) {
    const aiDesc = descriptions?.get(item.number);
    if (aiDesc) {
      body += `\n${formatEntryWithDescription(item, aiDesc, compact)}`;
    } else {
      body += `\n${formatEntry(item, compact)}`;
    }
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
  /** When set, uses the AI tool to generate enriched entry descriptions. */
  agentCommandTemplate?: string;
  execGh?: ExecGhFn;
  log?: (msg: string) => void;
  /** Injected tool executor for testing. */
  runTool?: (
    commandTemplate: string,
    prompt: string,
    timeoutMs: number,
  ) => Promise<ToolExecutorResult>;
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
  const { owner, repo, indexIssue, kind, recentDays, dryRun } = opts;
  const execGh = opts.execGh ?? defaultExecGh;
  const log = opts.log ?? (() => {});
  const runTool = opts.runTool ?? executeTool;

  // 1. Fetch all items
  log(`Scanning ${kind}...`);
  const items =
    kind === 'prs'
      ? fetchAllPRs(owner, repo, execGh, log)
      : fetchAllIssues(owner, repo, execGh, log);

  log(`${icons.info} Found ${items.length} ${kind}.`);

  // 2. Categorize
  const { open, recentlyClosed, archived } = categorizeItems(items, recentDays);

  log(
    `  ${open.length} open, ${recentlyClosed.length} recently closed, ${archived.length} archived`,
  );

  // 3. Fetch existing comments on the index issue
  const comments = fetchIssueComments(owner, repo, indexIssue, execGh);
  const found = findIndexComments(comments);

  // Count new entries (needed before AI enrichment to know which items to process)
  const existingOpen = found.open ? parseExistingNumbers(found.open.body) : new Set<number>();
  const existingRecent = found.recent ? parseExistingNumbers(found.recent.body) : new Set<number>();
  const existingArchived = found.archived
    ? parseExistingNumbers(found.archived.body)
    : new Set<number>();

  const newOpenItems = open.filter((i) => !existingOpen.has(i.number));
  const newRecentItems = recentlyClosed.filter((i) => !existingRecent.has(i.number));
  const newArchivedItems = archived.filter((i) => !existingArchived.has(i.number));
  const newEntries = newOpenItems.length + newRecentItems.length + newArchivedItems.length;

  // 3b. Generate AI-enriched descriptions if agent is configured
  const descriptions = new Map<number, string>();
  if (opts.agentCommandTemplate && newEntries > 0) {
    const allNewItems = [...newOpenItems, ...newRecentItems, ...newArchivedItems];
    log(`\nGenerating AI-enriched descriptions for ${allNewItems.length} items...`);
    for (let i = 0; i < allNewItems.length; i++) {
      const item = allNewItems[i];
      log(`  Processing item ${i + 1}/${allNewItems.length} (#${item.number})...`);
      const desc = await generateAIEntry(item, kind, opts.agentCommandTemplate, runTool);
      if (desc) {
        descriptions.set(item.number, desc);
      } else {
        log(`  ${icons.warn} AI failed for #${item.number}, using raw title`);
      }
    }
    const enriched = descriptions.size;
    log(
      `${icons.info} AI enrichment: ${enriched}/${allNewItems.length} items enriched successfully`,
    );
  }

  // 4. Build updated comment bodies (merging without duplicates)
  const openBody = buildCommentBody(
    OPEN_MARKER,
    'Open Items',
    open,
    found.open?.body ?? null,
    false,
    descriptions,
  );
  const recentBody = buildCommentBody(
    RECENT_MARKER,
    'Recently Closed Items',
    recentlyClosed,
    found.recent?.body ?? null,
    false,
    descriptions,
  );
  const archivedBody = buildCommentBody(
    ARCHIVED_MARKER,
    'Archived Items',
    archived,
    found.archived?.body ?? null,
    true, // compact format
    descriptions,
  );

  if (dryRun) {
    log(`\n${icons.info} Dry run — would update index issue #${indexIssue}:`);
    log(`  Open Items: ${open.length} entries (${newOpenItems.length} new)`);
    log(`  Recently Closed: ${recentlyClosed.length} entries (${newRecentItems.length} new)`);
    log(`  Archived: ${archived.length} entries (${newArchivedItems.length} new)`);
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
    updateIssueComment(owner, repo, found.open.id, openBody, execGh);
  } else {
    createIssueComment(owner, repo, indexIssue, openBody, execGh);
  }

  if (found.recent) {
    updateIssueComment(owner, repo, found.recent.id, recentBody, execGh);
  } else {
    createIssueComment(owner, repo, indexIssue, recentBody, execGh);
  }

  if (found.archived) {
    updateIssueComment(owner, repo, found.archived.id, archivedBody, execGh);
  } else {
    createIssueComment(owner, repo, indexIssue, archivedBody, execGh);
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
  options: { repo?: string; all?: boolean; dryRun?: boolean; days?: string; agent?: string },
  deps: DedupInitDeps = {},
): Promise<void> {
  const execGh = deps.execGh ?? defaultExecGh;
  const log = deps.log ?? console.log;
  const logError = deps.logError ?? console.error;
  const resolveCmd = deps.resolveAgentCommandFn ?? resolveAgentCommand;

  // 1. Parse --repo flag
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

  // 2. Fetch .opencara.toml from the repo
  log(`Fetching .opencara.toml from ${options.repo}...`);
  const tomlContent = fetchRepoFile(owner, repo, '.opencara.toml', execGh);
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

  // 3. Determine which indexes to initialize
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

  // 4. Resolve agent command template if --agent is specified
  let agentCommandTemplate: string | undefined;
  if (options.agent) {
    const cmd = resolveCmd(options.agent);
    if (!cmd) {
      logError(
        `${icons.error} Unknown agent tool "${options.agent}". Available: ${loadToolDefs()
          .map((t) => t.name)
          .join(', ')}`,
      );
      process.exitCode = 1;
      return;
    }
    agentCommandTemplate = cmd;
    log(`Using AI agent "${options.agent}" for enriched descriptions`);
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
      agentCommandTemplate,
      execGh,
      log,
      runTool: deps.runTool,
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
    .option(
      '--agent <tool-name>',
      'Use AI agent to generate enriched descriptions (e.g., claude, codex, gemini, qwen)',
    )
    .action(
      async (options: {
        repo: string;
        all?: boolean;
        dryRun?: boolean;
        days?: string;
        agent?: string;
      }) => {
        await runDedupInit(options);
      },
    );

  return dedup;
}
