import Anthropic from '@anthropic-ai/sdk';
import type { ReviewVerdict } from '@opencrust/shared';

export interface ReviewRequest {
  taskId: string;
  diffContent: string;
  prompt: string;
  owner: string;
  repo: string;
  prNumber: number;
  timeout: number;
}

export interface ReviewResponse {
  review: string;
  verdict: ReviewVerdict;
  tokensUsed: number;
}

const SYSTEM_PROMPT_TEMPLATE = `You are a code reviewer for the {owner}/{repo} repository.
Review the following pull request diff and provide:
1. A verdict: APPROVE, REQUEST_CHANGES, or COMMENT
2. A detailed review in markdown format

Start your response with one of these exact lines:
VERDICT: APPROVE
VERDICT: REQUEST_CHANGES
VERDICT: COMMENT

Then provide your review.`;

export function buildSystemPrompt(owner: string, repo: string): string {
  return SYSTEM_PROMPT_TEMPLATE.replace('{owner}', owner).replace('{repo}', repo);
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
  anthropicApiKey: string;
  reviewModel: string;
  maxDiffSizeKb: number;
}

export function getAnthropicApiKey(configKey: string | null): string {
  const envKey = process.env['ANTHROPIC_API_KEY'];
  if (envKey) return envKey;
  if (configKey) return configKey;
  throw new Error(
    'Anthropic API key not found. Set ANTHROPIC_API_KEY environment variable or add anthropic_api_key to ~/.opencrust/config.yml',
  );
}

export async function executeReview(
  req: ReviewRequest,
  deps: ReviewExecutorDeps,
  createClient: (apiKey: string) => Anthropic = (key) => new Anthropic({ apiKey: key }),
): Promise<ReviewResponse> {
  const diffSizeKb = Buffer.byteLength(req.diffContent, 'utf-8') / 1024;
  if (diffSizeKb > deps.maxDiffSizeKb) {
    throw new DiffTooLargeError(
      `Diff too large (${Math.round(diffSizeKb)}KB > ${deps.maxDiffSizeKb}KB limit)`,
    );
  }

  const startTime = Date.now();
  const timeoutMs = req.timeout * 1000;
  const safetyMarginMs = 30_000;

  const remainingMs = timeoutMs - (Date.now() - startTime);
  if (remainingMs <= safetyMarginMs) {
    throw new Error('Not enough time remaining to start review');
  }

  const abortController = new AbortController();
  const abortTimer = setTimeout(() => {
    abortController.abort();
  }, remainingMs - safetyMarginMs);

  try {
    const client = createClient(deps.anthropicApiKey);
    const response = await client.messages.create(
      {
        model: deps.reviewModel,
        max_tokens: 4096,
        system: buildSystemPrompt(req.owner, req.repo),
        messages: [
          {
            role: 'user',
            content: buildUserMessage(req.prompt, req.diffContent),
          },
        ],
      },
      { signal: abortController.signal },
    );

    const rawText = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const { verdict, review } = extractVerdict(rawText);
    const tokensUsed = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

    return { review, verdict, tokensUsed };
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
