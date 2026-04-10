import type { ReviewVerdict } from '@opencara/shared';
import type { ReviewExecutorDeps, ReviewMetadata } from './review.js';
import { extractVerdict, VERDICT_EMOJI } from './review.js';
import { buildSummarySystemPrompt, buildSummaryUserMessage } from './prompts.js';
export { buildSummarySystemPrompt, buildSummaryUserMessage };
import {
  executeTool,
  estimateTokens,
  type ToolExecutorResult,
  type TokenUsageDetail,
} from './tool-executor.js';

export interface SummaryReviewInput {
  agentId: string;
  model: string;
  tool: string;
  review: string;
  verdict: string;
}

export interface SummaryRequest {
  taskId: string;
  reviews: SummaryReviewInput[];
  prompt: string;
  owner: string;
  repo: string;
  prNumber: number;
  timeout: number;
  diffContent: string;
  contextBlock?: string;
}

export interface FlaggedReview {
  agentId: string;
  reason: string;
}

export interface SummaryResponse {
  summary: string;
  verdict: ReviewVerdict;
  tokensUsed: number;
  tokensEstimated: boolean;
  tokenDetail: TokenUsageDetail;
  flaggedReviews: FlaggedReview[];
  /** Raw stdout from the tool execution (available for verbose logging). */
  toolStdout: string;
  /** Raw stderr from the tool execution (available for verbose logging). */
  toolStderr: string;
  /** Length of the prompt sent to the tool in characters. */
  promptLength: number;
}

export const TIMEOUT_SAFETY_MARGIN_MS = 30_000;
export const MAX_INPUT_SIZE_BYTES = 200 * 1024;

export class InputTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputTooLargeError';
  }
}

export interface SummaryMetadata extends ReviewMetadata {
  reviewerModels: string[];
}

export function buildSummaryMetadataHeader(verdict: ReviewVerdict, meta?: SummaryMetadata): string {
  if (!meta) return '';
  const emoji = VERDICT_EMOJI[verdict] ?? '';
  const reviewersList = meta.reviewerModels.map((r) => `\`${r}\``).join(', ');
  const lines: string[] = [
    `**Reviewers**: ${reviewersList}`,
    `**Synthesizer**: \`${meta.model}/${meta.tool}\``,
  ];
  lines.push(`**Verdict**: ${emoji} ${verdict}`);
  return lines.join('\n') + '\n\n';
}

/**
 * Extract flagged reviews from the synthesizer's "## Flagged Reviews" section.
 * Returns an empty array if no section found or if it says "No flagged reviews."
 */
export function extractFlaggedReviews(text: string): FlaggedReview[] {
  const sectionMatch = /##\s*Flagged Reviews\s*\n([\s\S]*?)(?=\n##\s|\n---|\s*$)/i.exec(text);
  if (!sectionMatch) return [];

  const sectionBody = sectionMatch[1].trim();
  if (/no flagged reviews/i.test(sectionBody)) return [];

  const flagged: FlaggedReview[] = [];
  // Match lines like: - **agent-id**: reason text
  const linePattern = /^-\s+\*\*([^*]+)\*\*:\s*(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(sectionBody)) !== null) {
    flagged.push({
      agentId: match[1].trim(),
      reason: match[2].trim(),
    });
  }
  return flagged;
}

export function calculateInputSize(
  prompt: string,
  reviews: SummaryReviewInput[],
  diffContent: string,
  contextBlock?: string,
): number {
  let size = Buffer.byteLength(prompt, 'utf-8');
  size += Buffer.byteLength(diffContent, 'utf-8');
  if (contextBlock) {
    size += Buffer.byteLength(contextBlock, 'utf-8');
  }
  for (const r of reviews) {
    size += Buffer.byteLength(r.review, 'utf-8');
    size += Buffer.byteLength(r.model, 'utf-8');
    size += Buffer.byteLength(r.tool, 'utf-8');
    size += Buffer.byteLength(r.verdict, 'utf-8');
  }
  return size;
}

export async function executeSummary(
  req: SummaryRequest,
  deps: ReviewExecutorDeps,
  runTool: (
    commandTemplate: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
    vars?: Record<string, string>,
    cwd?: string,
    livenessTimeoutMs?: number,
  ) => Promise<ToolExecutorResult> = executeTool,
): Promise<SummaryResponse> {
  const inputSize = calculateInputSize(req.prompt, req.reviews, req.diffContent, req.contextBlock);
  if (inputSize > MAX_INPUT_SIZE_BYTES) {
    throw new InputTooLargeError(
      `Summary input too large (${Math.round(inputSize / 1024)}KB > ${Math.round(MAX_INPUT_SIZE_BYTES / 1024)}KB limit)`,
    );
  }

  const timeoutMs = req.timeout * 1000;
  if (timeoutMs <= TIMEOUT_SAFETY_MARGIN_MS) {
    throw new Error('Not enough time remaining to start summary');
  }

  const effectiveTimeout = timeoutMs - TIMEOUT_SAFETY_MARGIN_MS;
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => {
    abortController.abort();
  }, effectiveTimeout);

  try {
    const systemPrompt = buildSummarySystemPrompt(req.owner, req.repo, req.reviews.length);
    const userMessage = buildSummaryUserMessage(
      req.prompt,
      req.reviews,
      req.diffContent,
      req.contextBlock,
    );
    const fullPrompt = `${systemPrompt}\n\n${userMessage}`;

    const result = await runTool(
      deps.commandTemplate,
      fullPrompt,
      effectiveTimeout,
      abortController.signal,
      undefined,
      deps.codebaseDir ?? undefined,
      deps.livenessTimeoutMs,
    );

    const { verdict, review } = extractVerdict(result.stdout);
    const flaggedReviews = extractFlaggedReviews(result.stdout);
    // Only add input estimate when tokens were estimated (not parsed from tool output)
    const inputTokens = result.tokensParsed ? 0 : estimateTokens(fullPrompt);
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
      summary: review,
      verdict,
      tokensUsed: result.tokensUsed + inputTokens,
      tokensEstimated: !result.tokensParsed,
      tokenDetail,
      flaggedReviews,
      toolStdout: result.stdout,
      toolStderr: result.stderr,
      promptLength: fullPrompt.length,
    };
  } finally {
    clearTimeout(abortTimer);
  }
}
