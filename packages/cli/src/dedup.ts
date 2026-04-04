import { execFileSync } from 'node:child_process';
import type { DedupReport, DedupMatch, TaskRole } from '@opencara/shared';
import type { ApiClient } from './http.js';
import type { ReviewExecutorDeps } from './review.js';
import type { ConsumptionDeps } from './commands/agent.js';
import type { Logger } from './logger.js';
import type { ToolExecutorResult, TokenUsageDetail } from './tool-executor.js';
import { executeTool, estimateTokens } from './tool-executor.js';
import { sanitizeTokens } from './sanitize.js';
import { withRetry } from './retry.js';
import { recordSessionUsage, type RecordUsageOptions } from './consumption.js';
import { icons } from './logger.js';
import { buildDedupPrompt } from './prompts.js';
export { buildDedupPrompt };

export const TIMEOUT_SAFETY_MARGIN_MS = 30_000;

/** Maximum number of retries when AI output fails to parse as valid JSON. */
const MAX_PARSE_RETRIES = 1;

// ── Output Parsing ────────────────────────────────────────────

/**
 * Extract a JSON object from AI output that may contain markdown fences,
 * preamble text, or other wrapping.
 */
export function extractJson(text: string): string | null {
  // Try fenced code block first (```json ... ``` or ``` ... ```)
  const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)```/.exec(text);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  // Try to find a raw JSON object
  const jsonStart = text.indexOf('{');
  const jsonEnd = text.lastIndexOf('}');
  if (jsonStart !== -1 && jsonEnd > jsonStart) {
    return text.slice(jsonStart, jsonEnd + 1);
  }

  return null;
}

const VALID_SIMILARITIES = new Set(['exact', 'high', 'partial']);

/**
 * Parse and validate a DedupReport from raw AI output text.
 * Throws if the output cannot be parsed or is invalid.
 */
export function parseDedupReport(text: string): DedupReport {
  const jsonStr = extractJson(text);
  if (!jsonStr) {
    throw new Error('No JSON object found in AI output');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    throw new Error('Invalid JSON in AI output');
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('AI output is not a JSON object');
  }

  const obj = parsed as Record<string, unknown>;

  if (!Array.isArray(obj.duplicates)) {
    throw new Error('Missing or invalid "duplicates" array');
  }

  if (typeof obj.index_entry !== 'string') {
    throw new Error('Missing or invalid "index_entry" string');
  }

  const duplicates: DedupMatch[] = [];
  for (const item of obj.duplicates) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) {
      throw new Error('Invalid duplicate entry');
    }
    const entry = item as Record<string, unknown>;
    const rawNum = entry.number;
    const num =
      typeof rawNum === 'number'
        ? rawNum
        : typeof rawNum === 'string' && /^#?\d+$/.test(rawNum)
          ? parseInt(rawNum.replace(/^#/, ''), 10)
          : NaN;
    if (isNaN(num)) {
      throw new Error('Duplicate entry missing valid "number"');
    }
    if (typeof entry.similarity !== 'string' || !VALID_SIMILARITIES.has(entry.similarity)) {
      throw new Error(
        `Invalid similarity "${String(entry.similarity)}" — must be exact, high, or partial`,
      );
    }
    if (typeof entry.description !== 'string') {
      throw new Error('Duplicate entry missing "description"');
    }
    duplicates.push({
      number: num,
      similarity: entry.similarity as DedupMatch['similarity'],
      description: entry.description,
    });
  }

  return {
    duplicates,
    index_entry: obj.index_entry as string,
  };
}

// ── Executor ──────────────────────────────────────────────────

export interface DedupExecutorDeps {
  commandTemplate: string;
  codebaseDir?: string | null;
}

export interface DedupResponse {
  report: DedupReport;
  tokensUsed: number;
  tokensEstimated: boolean;
  tokenDetail: TokenUsageDetail;
}

/**
 * Execute a dedup task: build prompt, run AI tool, parse output.
 * Retries once on parse failure.
 */
export async function executeDedup(
  prompt: string,
  timeoutSeconds: number,
  deps: DedupExecutorDeps,
  runTool: (
    commandTemplate: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
    vars?: Record<string, string>,
    cwd?: string,
  ) => Promise<ToolExecutorResult> = executeTool,
  signal?: AbortSignal,
): Promise<DedupResponse> {
  const timeoutMs = timeoutSeconds * 1000;
  if (timeoutMs <= TIMEOUT_SAFETY_MARGIN_MS) {
    throw new Error('Not enough time remaining to start dedup');
  }

  const effectiveTimeout = timeoutMs - TIMEOUT_SAFETY_MARGIN_MS;
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => {
    abortController.abort();
  }, effectiveTimeout);

  // Combine caller signal with our timeout
  const onParentAbort = () => abortController.abort();
  if (signal?.aborted) {
    abortController.abort();
  } else {
    signal?.addEventListener('abort', onParentAbort, { once: true });
  }

  try {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_PARSE_RETRIES; attempt++) {
      const result = await runTool(
        deps.commandTemplate,
        prompt,
        effectiveTimeout,
        abortController.signal,
        undefined,
        deps.codebaseDir ?? undefined,
      );

      try {
        const report = parseDedupReport(result.stdout);
        const inputTokens = result.tokensParsed ? 0 : estimateTokens(prompt);
        const detail = result.tokenDetail;
        const tokenDetail: TokenUsageDetail = result.tokensParsed
          ? detail
          : {
              input: inputTokens,
              output: detail.output,
              total: inputTokens + detail.output,
              parsed: false,
            };
        return {
          report,
          tokensUsed: result.tokensUsed + inputTokens,
          tokensEstimated: !result.tokensParsed,
          tokenDetail,
        };
      } catch (err) {
        lastError = err as Error;
        if (attempt < MAX_PARSE_RETRIES) {
          console.warn(`Dedup output parse failed (attempt ${attempt + 1}), retrying...`);
        }
      }
    }

    throw new Error(
      `Failed to parse dedup report after ${MAX_PARSE_RETRIES + 1} attempts: ${lastError?.message}`,
    );
  } finally {
    clearTimeout(abortTimer);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

// ── Auto-build Index from GitHub API ─────────────────────────

/** Type for the injected gh CLI executor — matches ExecGhFn in commands/dedup.ts. */
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

/** Dependencies for buildIndexFromGitHub — allows injection for testing. */
export interface BuildIndexDeps {
  execGh: ExecGhFn;
}

interface GhPrListItem {
  number: number;
  title: string;
  state: string;
  labels: Array<{ name: string }>;
}

/**
 * Fetch PRs from GitHub via `gh pr list` and format as dedup index body.
 * Used when no `index_issue` is configured — builds context on the fly.
 *
 * @param owner - Repository owner
 * @param repo - Repository name
 * @param currentPrNumber - Current PR number to exclude from the index
 * @param deps - Injectable dependencies (execGh)
 */
export function buildIndexFromGitHub(
  owner: string,
  repo: string,
  currentPrNumber: number,
  deps: BuildIndexDeps,
): string {
  const repoSlug = `${owner}/${repo}`;

  // Fetch open PRs (up to 100)
  const openRaw = deps.execGh([
    'pr',
    'list',
    '--repo',
    repoSlug,
    '--state',
    'open',
    '--json',
    'number,title,labels',
    '--limit',
    '100',
  ]);
  const openPrs: GhPrListItem[] = JSON.parse(openRaw);

  // Fetch recently closed PRs (up to 50)
  const closedRaw = deps.execGh([
    'pr',
    'list',
    '--repo',
    repoSlug,
    '--state',
    'closed',
    '--json',
    'number,title,labels',
    '--limit',
    '50',
  ]);
  const closedPrs: GhPrListItem[] = JSON.parse(closedRaw);

  // Filter out the current PR
  const filteredOpen = openPrs.filter((pr) => pr.number !== currentPrNumber);
  const filteredClosed = closedPrs.filter((pr) => pr.number !== currentPrNumber);

  // Format entries: `- <number>(<labels>): <title>`
  const formatPr = (pr: GhPrListItem): string => {
    const labels = pr.labels.map((l) => l.name).join(', ');
    return `- ${pr.number}(${labels}): ${pr.title}`;
  };

  const lines: string[] = [];
  lines.push('## Open Items');
  for (const pr of filteredOpen) {
    lines.push(formatPr(pr));
  }
  lines.push('');
  lines.push('## Recently Closed Items');
  for (const pr of filteredClosed) {
    lines.push(formatPr(pr));
  }

  return lines.join('\n');
}

// ── Agent Loop Integration ────────────────────────────────────

/**
 * Execute a dedup task end-to-end: build prompt, run AI, parse, submit result.
 * Called from handleTask in the agent loop.
 */
export async function executeDedupTask(
  client: ApiClient,
  agentId: string,
  taskId: string,
  task: {
    owner: string;
    repo: string;
    pr_number: number;
    issue_title?: string;
    issue_body?: string;
    diff_url: string;
    index_issue_body?: string;
    prompt?: string;
  },
  diffContent: string,
  timeoutSeconds: number,
  reviewDeps: ReviewExecutorDeps,
  consumptionDeps: ConsumptionDeps,
  logger: Logger,
  signal?: AbortSignal,
  role: TaskRole = 'pr_dedup',
  buildIndexDeps?: BuildIndexDeps,
): Promise<void> {
  logger.log(`  ${icons.running} Executing dedup: ${reviewDeps.commandTemplate}`);

  // Auto-build dedup context from GitHub API when no index issue is configured
  if (!task.index_issue_body && buildIndexDeps) {
    logger.log(`  ${icons.info} No index issue configured — building context from GitHub API`);
    try {
      task.index_issue_body = buildIndexFromGitHub(
        task.owner,
        task.repo,
        task.pr_number,
        buildIndexDeps,
      );
    } catch (err) {
      logger.log(`  ${icons.warn} Failed to fetch PR list from GitHub: ${(err as Error).message}`);
    }
  }

  const prompt = buildDedupPrompt({ ...task, diffContent, customPrompt: task.prompt });

  const result = await executeDedup(
    prompt,
    timeoutSeconds,
    {
      commandTemplate: reviewDeps.commandTemplate,
      codebaseDir: reviewDeps.codebaseDir,
    },
    undefined,
    signal,
  );

  const { report } = result;
  const dupCount = report.duplicates.length;
  const summaryText =
    dupCount > 0
      ? `Found ${dupCount} duplicate(s): ${report.duplicates.map((d) => `#${d.number} (${d.similarity})`).join(', ')}`
      : 'No duplicates found.';

  const sanitizedSummary = sanitizeTokens(summaryText);

  await withRetry(
    () =>
      client.post(`/api/tasks/${taskId}/result`, {
        agent_id: agentId,
        type: role,
        review_text: sanitizedSummary,
        dedup_report: report,
        tokens_used: result.tokensUsed,
      }),
    { maxAttempts: 3 },
    signal,
  );

  const usageOpts: RecordUsageOptions = {
    inputTokens: result.tokenDetail.input,
    outputTokens: result.tokenDetail.output,
    totalTokens: result.tokensUsed,
    estimated: result.tokensEstimated,
  };
  recordSessionUsage(consumptionDeps.session, usageOpts);
  if (consumptionDeps.usageTracker) {
    consumptionDeps.usageTracker.recordTask(
      {
        input: usageOpts.inputTokens,
        output: usageOpts.outputTokens,
        estimated: usageOpts.estimated,
      },
      consumptionDeps.agentId,
    );
  }

  logger.log(
    `  ${icons.success} Dedup submitted (${result.tokensUsed.toLocaleString()} tokens) — ${dupCount} duplicate(s)`,
  );
}
