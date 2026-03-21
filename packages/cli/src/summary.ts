import type { ReviewExecutorDeps } from './review.js';
import { executeTool, estimateTokens, type ToolExecutorResult } from './tool-executor.js';

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
}

export interface SummaryResponse {
  summary: string;
  tokensUsed: number;
  tokensEstimated: boolean;
}

export const TIMEOUT_SAFETY_MARGIN_MS = 30_000;
export const MAX_INPUT_SIZE_BYTES = 200 * 1024;

export class InputTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputTooLargeError';
  }
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
): string {
  const reviewSections = reviews
    .map((r) => `### Review by ${r.model}/${r.tool} (Verdict: ${r.verdict})\n${r.review}`)
    .join('\n\n');

  return `Project review guidelines:\n${prompt}\n\n---\n\nPull request diff:\n\n${diffContent}\n\n---\n\nCompact reviews from other agents:\n\n${reviewSections}`;
}

export function calculateInputSize(
  prompt: string,
  reviews: SummaryReviewInput[],
  diffContent: string,
): number {
  let size = Buffer.byteLength(prompt, 'utf-8');
  size += Buffer.byteLength(diffContent, 'utf-8');
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
  const inputSize = calculateInputSize(req.prompt, req.reviews, req.diffContent);
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
    const userMessage = buildSummaryUserMessage(req.prompt, req.reviews, req.diffContent);
    const fullPrompt = `${systemPrompt}\n\n${userMessage}`;

    const result = await runTool(
      deps.commandTemplate,
      fullPrompt,
      effectiveTimeout,
      abortController.signal,
      undefined,
      deps.codebaseDir ?? undefined,
    );

    // Only add input estimate when tokens were estimated (not parsed from tool output)
    const inputTokens = result.tokensParsed ? 0 : estimateTokens(fullPrompt);
    return {
      summary: result.stdout,
      tokensUsed: result.tokensUsed + inputTokens,
      tokensEstimated: !result.tokensParsed,
    };
  } finally {
    clearTimeout(abortTimer);
  }
}
