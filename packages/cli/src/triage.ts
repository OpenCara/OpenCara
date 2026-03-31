import type {
  TriageReport,
  TriageCategory,
  TriagePriority,
  TriageSize,
  PollTask,
  TaskRole,
} from '@opencara/shared';
import {
  executeTool,
  estimateTokens,
  type ToolExecutorResult,
  type TokenUsageDetail,
} from './tool-executor.js';
import { sanitizeTokens } from './sanitize.js';
import { buildTriagePrompt } from './prompts.js';
export { buildTriagePrompt };

// ── Constants ────────────────────────────────────────────────────

/** Maximum issue body size in bytes before truncation. */
export const MAX_ISSUE_BODY_BYTES = 10 * 1024; // 10KB

const VALID_CATEGORIES: readonly TriageCategory[] = [
  'bug',
  'feature',
  'improvement',
  'question',
  'docs',
  'chore',
];
const VALID_PRIORITIES: readonly TriagePriority[] = ['critical', 'high', 'medium', 'low'];
const VALID_SIZES: readonly TriageSize[] = ['XS', 'S', 'M', 'L', 'XL'];

const TIMEOUT_SAFETY_MARGIN_MS = 30_000;

// ── Helpers ──────────────────────────────────────────────────────

/**
 * Truncate a string to a maximum byte length, appending a truncation notice.
 */
export function truncateToBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf-8');
  if (buf.length <= maxBytes) return text;
  // Decode the slice — Node replaces incomplete trailing sequences with U+FFFD.
  // Trim any trailing replacement characters to avoid corrupted output.
  const truncated = buf
    .subarray(0, maxBytes)
    .toString('utf-8')
    .replace(/\uFFFD+$/, '');
  return truncated + '\n\n[... truncated to 10KB ...]';
}

// ── Output Parsing ───────────────────────────────────────────────

/**
 * Extract a JSON object from AI output that may contain markdown fences or preamble.
 */
export function extractJsonFromOutput(output: string): string {
  // Try to find JSON in markdown code fences first (require non-empty content)
  const fenceMatch = output.match(/```(?:json)?\s*\n?([\s\S]+?)\n?\s*```/);
  if (fenceMatch && fenceMatch[1].trim().length > 0) {
    return fenceMatch[1].trim();
  }

  // Try to find a top-level JSON object
  const braceStart = output.indexOf('{');
  const braceEnd = output.lastIndexOf('}');
  if (braceStart !== -1 && braceEnd > braceStart) {
    return output.slice(braceStart, braceEnd + 1);
  }

  // Return as-is and let JSON.parse fail with a clear error
  return output.trim();
}

/**
 * Validate and coerce a parsed object into a TriageReport.
 * Throws on invalid enum values or missing required fields.
 */
export function validateTriageReport(obj: unknown): TriageReport {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error('Triage output is not an object');
  }

  const raw = obj as Record<string, unknown>;

  // Validate required enum fields
  const category = String(raw.category ?? '').toLowerCase() as TriageCategory;
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(
      `Invalid category "${raw.category}". Must be one of: ${VALID_CATEGORIES.join(', ')}`,
    );
  }

  const priority = String(raw.priority ?? '').toLowerCase() as TriagePriority;
  if (!VALID_PRIORITIES.includes(priority)) {
    throw new Error(
      `Invalid priority "${raw.priority}". Must be one of: ${VALID_PRIORITIES.join(', ')}`,
    );
  }

  const sizeRaw = String(raw.size ?? '').toUpperCase() as TriageSize;
  if (!VALID_SIZES.includes(sizeRaw)) {
    throw new Error(`Invalid size "${raw.size}". Must be one of: ${VALID_SIZES.join(', ')}`);
  }

  // Validate comment (required)
  const comment = typeof raw.comment === 'string' ? raw.comment : '';
  if (!comment) {
    throw new Error('Missing required field: comment');
  }

  // Optional fields
  const module = typeof raw.module === 'string' ? raw.module : undefined;
  const summary = typeof raw.summary === 'string' ? raw.summary : undefined;
  const body = typeof raw.body === 'string' ? raw.body : undefined;
  const labels = Array.isArray(raw.labels)
    ? raw.labels.filter((l): l is string => typeof l === 'string')
    : [];

  return {
    category,
    module,
    priority,
    size: sizeRaw,
    labels,
    summary,
    body,
    comment,
  };
}

/**
 * Parse AI output into a validated TriageReport.
 */
export function parseTriageOutput(output: string): TriageReport {
  const jsonStr = extractJsonFromOutput(output);
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonStr);
  } catch (err) {
    throw new Error(`Failed to parse triage output as JSON: ${(err as Error).message}`);
  }
  return validateTriageReport(parsed);
}

// ── Executor ─────────────────────────────────────────────────────

export interface TriageResponse {
  report: TriageReport;
  tokensUsed: number;
  tokensEstimated: boolean;
  tokenDetail: TokenUsageDetail;
}

export interface TriageExecutorDeps {
  commandTemplate: string;
}

/**
 * Execute a triage task: build prompt, run AI tool, parse output.
 * Retries once on parse failure.
 */
export async function executeTriage(
  task: PollTask,
  deps: TriageExecutorDeps,
  timeoutSeconds: number,
  signal?: AbortSignal,
  runTool: (
    commandTemplate: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<ToolExecutorResult> = executeTool,
): Promise<TriageResponse> {
  const timeoutMs = timeoutSeconds * 1000;
  if (timeoutMs <= TIMEOUT_SAFETY_MARGIN_MS) {
    throw new Error('Not enough time remaining to start triage');
  }

  const effectiveTimeout = timeoutMs - TIMEOUT_SAFETY_MARGIN_MS;
  const prompt = buildTriagePrompt(task);

  let lastError: Error | undefined;

  // Try up to 2 times (initial + 1 retry on parse failure)
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await runTool(deps.commandTemplate, prompt, effectiveTimeout, signal);

    try {
      const report = parseTriageOutput(result.stdout);

      // Compute token usage
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
      // Only retry on parse failure, not on tool execution failure
      if (attempt === 0) {
        continue;
      }
    }
  }

  throw new Error(`Triage output parsing failed after retry: ${lastError?.message}`);
}

/**
 * Execute a triage task end-to-end: run AI, parse output, submit result to server.
 */
export async function executeTriageTask(
  client: { post: <T>(path: string, body: unknown) => Promise<T> },
  agentId: string,
  task: PollTask,
  deps: TriageExecutorDeps,
  timeoutSeconds: number,
  logger: { log: (msg: string) => void },
  signal?: AbortSignal,
  runTool?: (
    commandTemplate: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<ToolExecutorResult>,
  role: TaskRole = 'issue_triage',
): Promise<{ tokensUsed: number; tokensEstimated: boolean; tokenDetail: TokenUsageDetail }> {
  logger.log(`  Executing triage for issue: ${task.issue_title ?? `#${task.pr_number}`}`);

  const result = await executeTriage(task, deps, timeoutSeconds, signal, runTool);

  // Submit result to server
  await client.post(`/api/tasks/${task.task_id}/result`, {
    agent_id: agentId,
    type: role,
    review_text: sanitizeTokens(result.report.comment),
    tokens_used: result.tokensUsed,
    triage_report: result.report,
  });

  logger.log(`  Triage submitted (${result.tokensUsed.toLocaleString()} tokens)`);
  logger.log(
    `    Category: ${result.report.category} | Priority: ${result.report.priority} | Size: ${result.report.size}`,
  );

  return {
    tokensUsed: result.tokensUsed,
    tokensEstimated: result.tokensEstimated,
    tokenDetail: result.tokenDetail,
  };
}
