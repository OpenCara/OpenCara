import Anthropic from '@anthropic-ai/sdk';
import type { ReviewExecutorDeps } from './review.js';

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
}

export interface SummaryResponse {
  summary: string;
  tokensUsed: number;
}

export const TIMEOUT_SAFETY_MARGIN_MS = 30_000;
export const MAX_RESPONSE_TOKENS = 4096;
export const MAX_INPUT_SIZE_BYTES = 200 * 1024;

export class InputTooLargeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputTooLargeError';
  }
}

export function buildSummarySystemPrompt(owner: string, repo: string, reviewCount: number): string {
  return `You are a code review summarizer for the ${owner}/${repo} repository.

You have received ${reviewCount} individual code reviews for a Pull Request.
Your job is to synthesize these reviews into a single, coherent summary that:

1. Highlights the most important findings across all reviews
2. Notes areas of agreement and disagreement between reviewers
3. Provides a clear overall assessment
4. Lists specific action items for the PR author

Format your response as a markdown document. Be concise but thorough.`;
}

export function buildSummaryUserMessage(prompt: string, reviews: SummaryReviewInput[]): string {
  const reviewSections = reviews
    .map((r) => `### Review by ${r.model}/${r.tool} (Verdict: ${r.verdict})\n${r.review}`)
    .join('\n\n');

  return `Project review guidelines:\n${prompt}\n\nIndividual reviews:\n\n${reviewSections}`;
}

export function calculateInputSize(prompt: string, reviews: SummaryReviewInput[]): number {
  let size = Buffer.byteLength(prompt, 'utf-8');
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
  createClient: (apiKey: string) => Anthropic = (key) => new Anthropic({ apiKey: key }),
): Promise<SummaryResponse> {
  const inputSize = calculateInputSize(req.prompt, req.reviews);
  if (inputSize > MAX_INPUT_SIZE_BYTES) {
    throw new InputTooLargeError(
      `Summary input too large (${Math.round(inputSize / 1024)}KB > ${Math.round(MAX_INPUT_SIZE_BYTES / 1024)}KB limit)`,
    );
  }

  const timeoutMs = req.timeout * 1000;
  if (timeoutMs <= TIMEOUT_SAFETY_MARGIN_MS) {
    throw new Error('Not enough time remaining to start summary');
  }

  const abortController = new AbortController();
  const abortTimer = setTimeout(() => {
    abortController.abort();
  }, timeoutMs - TIMEOUT_SAFETY_MARGIN_MS);

  try {
    const client = createClient(deps.anthropicApiKey);
    const response = await client.messages.create(
      {
        model: deps.reviewModel,
        max_tokens: MAX_RESPONSE_TOKENS,
        system: buildSummarySystemPrompt(req.owner, req.repo, req.reviews.length),
        messages: [
          {
            role: 'user',
            content: buildSummaryUserMessage(req.prompt, req.reviews),
          },
        ],
      },
      { signal: abortController.signal },
    );

    const summary = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('\n');

    const tokensUsed = (response.usage?.input_tokens ?? 0) + (response.usage?.output_tokens ?? 0);

    return { summary, tokensUsed };
  } finally {
    clearTimeout(abortTimer);
  }
}
