import type { ReviewVerdict } from '@opencara/shared';
import {
  executeTool,
  estimateTokens,
  type ToolExecutorResult,
  type TokenUsageDetail,
} from './tool-executor.js';

export type ReviewMode = 'full' | 'compact';

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
  meta?: ReviewMetadata;
}

export interface ReviewResponse {
  review: string;
  verdict: ReviewVerdict;
  tokensUsed: number;
  tokensEstimated: boolean;
  tokenDetail: TokenUsageDetail;
}

export const TIMEOUT_SAFETY_MARGIN_MS = 30_000;

export interface ReviewMetadata {
  model: string;
  tool: string;
  githubUsername?: string;
}

const VERDICT_FORMAT_INSTRUCTION = `Format the verdict line with an emoji prefix:
- APPROVE → ✅ approve
- REQUEST_CHANGES → ❌ request_changes
- COMMENT → 💬 comment`;

function buildMetadataHeaderInstruction(meta?: ReviewMetadata): string {
  if (!meta) return '';
  const lines: string[] = [
    '',
    'At the very beginning of your response, include this metadata header:',
    '',
    `**Reviewer**: \`${meta.model}/${meta.tool}\``,
  ];
  if (meta.githubUsername) {
    lines.push(
      `**Contributors**: [@${meta.githubUsername}](https://github.com/${meta.githubUsername})`,
    );
  }
  lines.push('**Verdict**: {verdict_emoji} {verdict}');
  lines.push('');
  lines.push(
    'Replace {verdict_emoji} {verdict} with the actual verdict using the emoji format below.',
  );
  lines.push(VERDICT_FORMAT_INSTRUCTION);
  lines.push('');
  lines.push('Then continue with the rest of the review.');
  return lines.join('\n');
}

const FULL_SYSTEM_PROMPT_TEMPLATE = `You are a code reviewer for the {owner}/{repo} repository.
Review the following pull request diff and provide a structured review.
{metadata_header}
Format your response as:

## Summary
[2-3 sentence overall assessment]

## Findings
List each finding on its own line:
- **[severity]** \`file:line\` — description

Severities: critical, major, minor, suggestion
Only include findings with specific file:line references from the diff.
If no issues found, write "No issues found."

## Verdict
APPROVE | REQUEST_CHANGES | COMMENT`;

const COMPACT_SYSTEM_PROMPT_TEMPLATE = `You are a code reviewer for the {owner}/{repo} repository.
Review the following pull request diff and return a compact, structured assessment.
{metadata_header}
Format your response as:

## Summary
[1-2 sentence assessment]

## Findings
- **[severity]** \`file:line\` — description

Severities: critical, major, minor, suggestion

## Verdict
APPROVE | REQUEST_CHANGES | COMMENT`;

export function buildSystemPrompt(
  owner: string,
  repo: string,
  mode: ReviewMode = 'full',
  meta?: ReviewMetadata,
): string {
  const template =
    mode === 'compact' ? COMPACT_SYSTEM_PROMPT_TEMPLATE : FULL_SYSTEM_PROMPT_TEMPLATE;
  const metadataHeader = buildMetadataHeaderInstruction(meta);
  return template
    .replace('{owner}', owner)
    .replace('{repo}', repo)
    .replace('{metadata_header}', metadataHeader);
}

export function buildUserMessage(
  prompt: string,
  diffContent: string,
  contextBlock?: string,
): string {
  const parts = [prompt];
  if (contextBlock) {
    parts.push(contextBlock);
  }
  parts.push(diffContent);
  return parts.join('\n\n---\n\n');
}

// New format: ## Verdict section at end of markdown
const SECTION_VERDICT_PATTERN = /##\s*Verdict\s*\n+\s*(APPROVE|REQUEST_CHANGES|COMMENT)\b/im;
// Legacy format: VERDICT: X on its own line
const LEGACY_VERDICT_PATTERN = /^VERDICT:\s*(APPROVE|REQUEST_CHANGES|COMMENT)\s*$/m;

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
  githubToken?: string | null;
  codebaseDir?: string | null;
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
    const systemPrompt = buildSystemPrompt(req.owner, req.repo, req.reviewMode, req.meta);
    const userMessage = buildUserMessage(req.prompt, req.diffContent, req.contextBlock);
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
