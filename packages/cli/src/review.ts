import type { ReviewVerdict } from '@opencara/shared';
import {
  executeTool,
  estimateTokens,
  type ToolExecutorResult,
  type TokenUsageDetail,
} from './tool-executor.js';
import {
  type ReviewMode,
  TRUST_BOUNDARY_BLOCK,
  SEVERITY_RUBRIC_BLOCK,
  LARGE_DIFF_TRIAGE_BLOCK,
  buildSystemPrompt,
  buildUserMessage,
} from './prompts.js';

export type { ReviewMode };
export {
  TRUST_BOUNDARY_BLOCK,
  SEVERITY_RUBRIC_BLOCK,
  LARGE_DIFF_TRIAGE_BLOCK,
  buildSystemPrompt,
  buildUserMessage,
};

export interface ReviewRequest {
  taskId: string;
  diffContent: string;
  prompt: string;
  owner: string;
  repo: string;
  prNumber: number;
  timeout: number;
  reviewMode: ReviewMode;
  contextBlock?: string;
}

export interface ReviewResponse {
  review: string;
  verdict: ReviewVerdict;
  tokensUsed: number;
  tokensEstimated: boolean;
  tokenDetail: TokenUsageDetail;
  /** Raw stdout from the tool execution (available for verbose logging). */
  toolStdout: string;
  /** Raw stderr from the tool execution (available for verbose logging). */
  toolStderr: string;
  /** Length of the prompt sent to the tool in characters. */
  promptLength: number;
}

export const TIMEOUT_SAFETY_MARGIN_MS = 30_000;

export interface ReviewMetadata {
  model: string;
  tool: string;
}

export const VERDICT_EMOJI: Record<ReviewVerdict, string> = {
  approve: '\u2705',
  request_changes: '\u274C',
  comment: '\uD83D\uDCAC',
};

export function buildMetadataHeader(verdict: ReviewVerdict, meta?: ReviewMetadata): string {
  if (!meta) return '';
  const emoji = VERDICT_EMOJI[verdict] ?? '';
  const lines: string[] = [`**Reviewer**: \`${meta.model}/${meta.tool}\``];
  lines.push(`**Verdict**: ${emoji} ${verdict}`);
  return lines.join('\n') + '\n\n';
}

// New format: ## Verdict section at end of markdown
const SECTION_VERDICT_PATTERN = /##\s*Verdict\s*\n+\s*\*{0,3}(APPROVE|REQUEST_CHANGES|COMMENT)\b/im;
// Legacy format: VERDICT: X on its own line
const LEGACY_VERDICT_PATTERN = /^VERDICT:\s*(APPROVE|REQUEST_CHANGES|COMMENT)\s*$/m;
// Compact format: ## Blocking issues\n yes|no
const BLOCKING_ISSUES_PATTERN = /##\s*Blocking issues\s*\n+\s*(yes|no)\b/im;

export function extractVerdict(text: string): { verdict: ReviewVerdict; review: string } {
  // Try new ## Verdict section format first
  const sectionMatch = SECTION_VERDICT_PATTERN.exec(text);
  if (sectionMatch) {
    const verdictStr = sectionMatch[1].toLowerCase() as ReviewVerdict;
    // Remove the ## Verdict section from the review text
    const review = text
      .slice(0, sectionMatch.index)
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    return { verdict: verdictStr, review };
  }

  // Try compact format: ## Blocking issues → yes|no
  const blockingMatch = BLOCKING_ISSUES_PATTERN.exec(text);
  if (blockingMatch) {
    const blocking = blockingMatch[1].toLowerCase();
    const verdict: ReviewVerdict = blocking === 'yes' ? 'request_changes' : 'approve';
    // Remove both ## Blocking issues and ## Review confidence sections from the review text
    let review = text;
    // Remove blocking issues section (heading + value)
    review = review.replace(/##\s*Blocking issues\s*\n+\s*(?:yes|no)\b[^\n]*/im, '');
    // Remove review confidence section (heading + value)
    review = review.replace(/##\s*Review confidence\s*\n+\s*(?:high|medium|low)\b[^\n]*/im, '');
    review = review.replace(/\n{3,}/g, '\n\n').trim();
    return { verdict, review };
  }

  // Fall back to legacy VERDICT: X format
  const legacyMatch = LEGACY_VERDICT_PATTERN.exec(text);
  if (legacyMatch) {
    const verdictStr = legacyMatch[1].toLowerCase() as ReviewVerdict;
    const before = text.slice(0, legacyMatch.index);
    const after = text.slice(legacyMatch.index + legacyMatch[0].length);
    const review = (before + after).replace(/\n{3,}/g, '\n\n').trim();
    return { verdict: verdictStr, review };
  }

  // No verdict found — warn and default
  console.warn('No verdict found in review output, defaulting to COMMENT');
  return { verdict: 'comment', review: text };
}

export interface ReviewExecutorDeps {
  commandTemplate: string;
  maxDiffSizeKb: number;
  maxRepoSizeMb?: number;
  codebaseDir?: string | null;
  livenessTimeoutMs?: number;
}

export async function executeReview(
  req: ReviewRequest,
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
    const userMessage = buildUserMessage(req.prompt, req.diffContent, req.contextBlock);
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
      review,
      verdict,
      tokensUsed: result.tokensUsed + inputTokens,
      tokensEstimated: !result.tokensParsed,
      tokenDetail,
      toolStdout: result.stdout,
      toolStderr: result.stderr,
      promptLength: fullPrompt.length,
    };
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
