import type { ReviewMode, ReviewVerdict } from '@opencara/shared';
import { executeTool, estimateTokens, type ToolExecutorResult } from './tool-executor.js';

export interface ReviewRequest {
  taskId: string;
  diffContent: string;
  prompt: string;
  owner: string;
  repo: string;
  prNumber: number;
  timeout: number;
  reviewMode: ReviewMode;
}

export interface ReviewResponse {
  review: string;
  verdict: ReviewVerdict;
  tokensUsed: number;
}

export const TIMEOUT_SAFETY_MARGIN_MS = 30_000;

const FULL_SYSTEM_PROMPT_TEMPLATE = `You are a code reviewer for the {owner}/{repo} repository.
Review the following pull request diff and provide:
1. A verdict: APPROVE, REQUEST_CHANGES, or COMMENT
2. A detailed review in markdown format

Start your response with one of these exact lines:
VERDICT: APPROVE
VERDICT: REQUEST_CHANGES
VERDICT: COMMENT

Then provide your review.`;

const COMPACT_SYSTEM_PROMPT_TEMPLATE = `You are a code reviewer for the {owner}/{repo} repository.
Review the following pull request diff and return a compact, structured assessment.

Start with a verdict line:
VERDICT: APPROVE
VERDICT: REQUEST_CHANGES
VERDICT: COMMENT

Then list findings, one per line, in this format:
- [severity] file:line - description

Severities: critical, major, minor, suggestion

End with a brief summary (1-2 sentences).`;

export function buildSystemPrompt(owner: string, repo: string, mode: ReviewMode = 'full'): string {
  const template =
    mode === 'compact' ? COMPACT_SYSTEM_PROMPT_TEMPLATE : FULL_SYSTEM_PROMPT_TEMPLATE;
  return template.replace('{owner}', owner).replace('{repo}', repo);
}

export function buildUserMessage(prompt: string, diffContent: string): string {
  return `${prompt}\n\n---\n\n${diffContent}`;
}

const VERDICT_PATTERN = /^VERDICT:\s*(APPROVE|REQUEST_CHANGES|COMMENT)\s*$/m;

export function extractVerdict(text: string): { verdict: ReviewVerdict; review: string } {
  const match = VERDICT_PATTERN.exec(text);
  if (!match) {
    return { verdict: 'comment', review: text };
  }

  const verdictStr = match[1].toLowerCase() as ReviewVerdict;
  const before = text.slice(0, match.index);
  const after = text.slice(match.index + match[0].length);
  const review = (before + after).replace(/\n{3,}/g, '\n\n').trim();
  return { verdict: verdictStr, review };
}

export interface ReviewExecutorDeps {
  commandTemplate: string;
  maxDiffSizeKb: number;
}

export async function executeReview(
  req: ReviewRequest,
  deps: ReviewExecutorDeps,
  runTool: (
    commandTemplate: string,
    prompt: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ) => Promise<ToolExecutorResult> = executeTool,
): Promise<ReviewResponse> {
  const diffSizeKb = Buffer.byteLength(req.diffContent, 'utf-8') / 1024;
  if (diffSizeKb > deps.maxDiffSizeKb) {
    throw new DiffTooLargeError(
      `Diff too large (${Math.round(diffSizeKb)}KB > ${deps.maxDiffSizeKb}KB limit)`,
    );
  }

  const timeoutMs = req.timeout * 1000;
  if (timeoutMs <= TIMEOUT_SAFETY_MARGIN_MS) {
    throw new Error('Not enough time remaining to start review');
  }

  const effectiveTimeout = timeoutMs - TIMEOUT_SAFETY_MARGIN_MS;
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => {
    abortController.abort();
  }, effectiveTimeout);

  try {
    const systemPrompt = buildSystemPrompt(req.owner, req.repo, req.reviewMode);
    const userMessage = buildUserMessage(req.prompt, req.diffContent);
    const fullPrompt = `${systemPrompt}\n\n${userMessage}`;

    const result = await runTool(
      deps.commandTemplate,
      fullPrompt,
      effectiveTimeout,
      abortController.signal,
    );

    const { verdict, review } = extractVerdict(result.stdout);
    const inputTokens = estimateTokens(fullPrompt);
    return { review, verdict, tokensUsed: result.tokensUsed + inputTokens };
  } finally {
    clearTimeout(abortTimer);
  }
}

export class DiffTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiffTooLargeError';
  }
}
