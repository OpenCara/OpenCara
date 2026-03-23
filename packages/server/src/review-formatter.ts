import type { ReviewVerdict } from '@opencara/shared';

/** Agent info displayed in review headers */
export interface ReviewAgentInfo {
  model: string;
  tool: string;
  displayName?: string;
}

const VERDICT_EMOJI: Record<ReviewVerdict, string> = {
  approve: '\u2705',
  request_changes: '\u274C',
  comment: '\uD83D\uDCAC',
};

/** Escape markdown special characters to prevent injection. */
function escapeMarkdown(text: string): string {
  return text.replace(/[\\`*_{}[\]()#+\-.!|~>]/g, '\\$&');
}

/** Format a single agent as `model/tool`, prefixed with displayName if set. */
function formatAgentLabel(agent: ReviewAgentInfo): string {
  const base = `\`${agent.model}/${agent.tool}\``;
  return agent.displayName ? `${escapeMarkdown(agent.displayName)} (${base})` : base;
}

/**
 * Format the summary as the main PR comment.
 */
export function formatSummaryComment(
  summary: string,
  agents: ReviewAgentInfo[],
  synthesizerAgent: ReviewAgentInfo | null,
): string {
  const agentLabels = agents.map(formatAgentLabel);
  const synthLabel = synthesizerAgent ? formatAgentLabel(synthesizerAgent) : null;
  const agentsLine =
    agentLabels.length > 0
      ? `**Agents**: ${agentLabels.join(', ')}${synthLabel ? ` (synthesized by ${synthLabel})` : ''}`
      : synthLabel
        ? `**Agents**: ${synthLabel}`
        : '';
  return [
    '## \uD83D\uDD0D OpenCara Review',
    '',
    ...(agentsLine ? [agentsLine] : []),
    '',
    '---',
    '',
    summary,
    '',
    '---',
    '<sub>Reviewed by <a href="https://github.com/apps/opencara">OpenCara</a></sub>',
  ].join('\n');
}

/**
 * Format an individual review as a follow-up comment.
 */
export function formatIndividualReviewComment(
  model: string,
  tool: string,
  verdict: ReviewVerdict,
  review: string,
): string {
  const emoji = VERDICT_EMOJI[verdict];
  return [
    `### Agent: \`${model}\` / \`${tool}\``,
    `**Verdict**: ${emoji} ${verdict}`,
    '',
    review,
  ].join('\n');
}

/** A partial review collected before timeout. */
export interface TimeoutReview {
  model: string;
  tool: string;
  verdict: ReviewVerdict;
  review_text: string;
}

/**
 * Format a consolidated timeout comment containing all partial reviews
 * and the timeout message in a single GitHub comment.
 */
export function formatTimeoutComment(timeoutMinutes: number, reviews: TimeoutReview[]): string {
  if (reviews.length === 0) {
    return `**OpenCara**: Review timed out after ${timeoutMinutes} minutes.`;
  }

  const parts: string[] = [
    `**OpenCara**: Review timed out after ${timeoutMinutes} minutes. ${reviews.length} partial review(s) collected:`,
  ];

  for (let i = 0; i < reviews.length; i++) {
    const r = reviews[i];
    const emoji = VERDICT_EMOJI[r.verdict];
    parts.push('---');
    parts.push(`### Review ${i + 1} — ${emoji} ${r.verdict} (${r.model} / ${r.tool})`);
    parts.push('');
    parts.push(r.review_text);
  }

  return parts.join('\n');
}
