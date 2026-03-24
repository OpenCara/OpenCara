import type { ReviewExecutorDeps, ReviewMetadata } from './review.js';
import { extractVerdict } from './review.js';
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
  meta?: ReviewMetadata;
}

export interface SummaryResponse {
  summary: string;
  tokensUsed: number;
  tokensEstimated: boolean;
  tokenDetail: TokenUsageDetail;
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

const VERDICT_EMOJI: Record<string, string> = {
  approve: '\u2705',
  request_changes: '\u274C',
  comment: '\uD83D\uDCAC',
};

export function buildSummaryMetadataHeader(verdict: string, meta?: SummaryMetadata): string {
  if (!meta) return '';
  const emoji = VERDICT_EMOJI[verdict] ?? '';
  const reviewersList = meta.reviewerModels.map((r) => `\`${r}\``).join(', ');
  const lines: string[] = [
    `**Reviewers**: ${reviewersList}`,
    `**Synthesizer**: \`${meta.model}/${meta.tool}\``,
  ];
  if (meta.githubUsername) {
    lines.push(
      `**Contributors**: [@${meta.githubUsername}](https://github.com/${meta.githubUsername})`,
    );
  }
  lines.push(`**Verdict**: ${emoji} ${verdict}`);
  return lines.join('\n') + '\n\n';
}

export function buildSummarySystemPrompt(owner: string, repo: string, reviewCount: number): string {
  return `You are a senior code reviewer and lead synthesizer for the ${owner}/${repo} repository.

You will receive a pull request diff and ${reviewCount} review${reviewCount !== 1 ? 's' : ''} from other agents.

Your job:
1. Perform your own thorough, independent code review of the diff
2. Incorporate and synthesize ALL findings from the other reviews into yours
3. Deduplicate overlapping findings but preserve every unique insight
4. Provide detailed explanations and actionable fix suggestions for each issue
5. Produce ONE comprehensive, detailed review

Format your response as:

## Summary
[Overall assessment of the PR: what it does, its quality, and key concerns — 3-5 sentences]

## Findings

For each finding, provide a detailed entry:

### [severity] \`file:line\` — Short title
Detailed explanation of the issue, why it matters, and how to fix it.
Include code snippets showing the fix when helpful.

Severities: critical, major, minor, suggestion
Include ALL findings from ALL reviewers (deduplicated) plus your own discoveries.
For each finding, explain clearly what the problem is and how to fix it.

## Verdict
APPROVE | REQUEST_CHANGES | COMMENT`;
}

export function buildSummaryUserMessage(
  prompt: string,
  reviews: SummaryReviewInput[],
  diffContent: string,
  contextBlock?: string,
): string {
  const reviewSections = reviews
    .map((r) => `### Review by ${r.model}/${r.tool} (Verdict: ${r.verdict})\n${r.review}`)
    .join('\n\n');

  const parts = [`Project review guidelines:\n${prompt}`];
  if (contextBlock) {
    parts.push(contextBlock);
  }
  parts.push(`Pull request diff:\n\n${diffContent}`);
  parts.push(`Compact reviews from other agents:\n\n${reviewSections}`);
  return parts.join('\n\n---\n\n');
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
    const summaryMeta = req.meta
      ? {
          ...req.meta,
          reviewerModels: req.reviews.map((r) => `${r.model}/${r.tool}`),
        }
      : undefined;
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
    );

    const { verdict, review } = extractVerdict(result.stdout);
    const header = buildSummaryMetadataHeader(verdict, summaryMeta);
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
      summary: header + review,
      tokensUsed: result.tokensUsed + inputTokens,
      tokensEstimated: !result.tokensParsed,
      tokenDetail,
    };
  } finally {
    clearTimeout(abortTimer);
  }
}
