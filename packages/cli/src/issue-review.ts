import type { PollTask, TaskRole } from '@opencara/shared';
import {
  executeTool,
  estimateTokens,
  type ToolExecutorResult,
  type TokenUsageDetail,
} from './tool-executor.js';
import { sanitizeTokens } from './sanitize.js';
import { buildIssueReviewPrompt } from './prompts.js';
export { buildIssueReviewPrompt };

// ── Constants ────────────────────────────────────────────────────

const TIMEOUT_SAFETY_MARGIN_MS = 30_000;

/** Server requires review_text to be at least this many characters. */
const MIN_REVIEW_TEXT_LENGTH = 10;

// ── Executor ─────────────────────────────────────────────────────

export interface IssueReviewResponse {
  reviewText: string;
  tokensUsed: number;
  tokensEstimated: boolean;
  tokenDetail: TokenUsageDetail;
}

export interface IssueReviewExecutorDeps {
  commandTemplate: string;
}

/**
 * Execute an issue review task: build prompt, run AI tool, return review text.
 * Unlike triage, issue review returns free-form text (no JSON parsing needed).
 */
export async function executeIssueReview(
  task: PollTask,
  deps: IssueReviewExecutorDeps,
  timeoutSeconds: number,
  signal?: AbortSignal,
  runTool: (
    commandTemplate: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<ToolExecutorResult> = executeTool,
): Promise<IssueReviewResponse> {
  const timeoutMs = timeoutSeconds * 1000;
  if (timeoutMs <= TIMEOUT_SAFETY_MARGIN_MS) {
    throw new Error('Not enough time remaining to start issue review');
  }

  const effectiveTimeout = timeoutMs - TIMEOUT_SAFETY_MARGIN_MS;
  const prompt = buildIssueReviewPrompt(task);

  const result = await runTool(deps.commandTemplate, prompt, effectiveTimeout, signal);

  const reviewText = result.stdout.trim();
  if (!reviewText) {
    throw new Error('Issue review produced empty output');
  }
  if (reviewText.length < MIN_REVIEW_TEXT_LENGTH) {
    throw new Error(
      `Issue review output too short (${reviewText.length} chars, minimum ${MIN_REVIEW_TEXT_LENGTH})`,
    );
  }

  // Compute token usage
  const inputTokens = result.tokensParsed ? 0 : estimateTokens(prompt);
  const tokenDetail: TokenUsageDetail = result.tokensParsed
    ? result.tokenDetail
    : {
        input: inputTokens,
        output: result.tokenDetail.output,
        total: inputTokens + result.tokenDetail.output,
        parsed: false,
      };

  return {
    reviewText,
    tokensUsed: result.tokensUsed + inputTokens,
    tokensEstimated: !result.tokensParsed,
    tokenDetail,
  };
}

/**
 * Execute an issue review task end-to-end: run AI, submit result to server.
 */
export async function executeIssueReviewTask(
  client: { post: <T>(path: string, body: unknown) => Promise<T> },
  agentId: string,
  task: PollTask,
  deps: IssueReviewExecutorDeps,
  timeoutSeconds: number,
  logger: { log: (msg: string) => void },
  signal?: AbortSignal,
  runTool?: (
    commandTemplate: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<ToolExecutorResult>,
  role: TaskRole = 'issue_review',
): Promise<{ tokensUsed: number; tokensEstimated: boolean; tokenDetail: TokenUsageDetail }> {
  const issueRef = task.issue_title ?? `#${task.issue_number ?? task.pr_number}`;
  logger.log(`  Executing issue review for: ${issueRef}`);

  const result = await executeIssueReview(task, deps, timeoutSeconds, signal, runTool);

  // Submit result to server
  await client.post(`/api/tasks/${task.task_id}/result`, {
    agent_id: agentId,
    type: role,
    review_text: sanitizeTokens(result.reviewText),
    tokens_used: result.tokensUsed,
  });

  logger.log(`  Issue review submitted (${result.tokensUsed.toLocaleString()} tokens)`);

  return {
    tokensUsed: result.tokensUsed,
    tokensEstimated: result.tokensEstimated,
    tokenDetail: result.tokenDetail,
  };
}
