export interface TokenBreakdown {
  input: number;
  output: number;
  estimated: number;
}

export interface SessionStats {
  tokens: number;
  reviews: number;
  tokenBreakdown: TokenBreakdown;
}

export function createSessionTracker(): SessionStats {
  return { tokens: 0, reviews: 0, tokenBreakdown: { input: 0, output: 0, estimated: 0 } };
}

export interface RecordUsageOptions {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimated: boolean;
}

export function recordSessionUsage(session: SessionStats, tokensUsed: number): void;
export function recordSessionUsage(session: SessionStats, options: RecordUsageOptions): void;
export function recordSessionUsage(
  session: SessionStats,
  tokensOrOptions: number | RecordUsageOptions,
): void {
  if (typeof tokensOrOptions === 'number') {
    session.tokens += tokensOrOptions;
    session.reviews += 1;
    // Legacy path: count all as estimated
    session.tokenBreakdown.estimated += tokensOrOptions;
  } else {
    session.tokens += tokensOrOptions.totalTokens;
    session.reviews += 1;
    if (tokensOrOptions.estimated) {
      session.tokenBreakdown.estimated += tokensOrOptions.totalTokens;
    } else {
      session.tokenBreakdown.input += tokensOrOptions.inputTokens;
      session.tokenBreakdown.output += tokensOrOptions.outputTokens;
    }
  }
}

export function formatPostReviewStats(session: SessionStats): string {
  const { input, output, estimated } = session.tokenBreakdown;
  const hasBreakdown = input > 0 || output > 0;
  let detail = '';
  if (hasBreakdown) {
    const parts: string[] = [];
    if (input > 0) parts.push(`${input.toLocaleString()} in`);
    if (output > 0) parts.push(`${output.toLocaleString()} out`);
    if (estimated > 0) parts.push(`${estimated.toLocaleString()} est`);
    detail = ` (${parts.join(' + ')})`;
  }
  return `  Session: ${session.tokens.toLocaleString()} tokens${detail} / ${session.reviews} reviews`;
}
