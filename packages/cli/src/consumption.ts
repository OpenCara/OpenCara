export interface SessionStats {
  tokens: number;
  reviews: number;
}

export function createSessionTracker(): SessionStats {
  return { tokens: 0, reviews: 0 };
}

export function recordSessionUsage(session: SessionStats, tokensUsed: number): void {
  session.tokens += tokensUsed;
  session.reviews += 1;
}

export function formatPostReviewStats(session: SessionStats): string {
  return `  Session: ${session.tokens.toLocaleString()} tokens / ${session.reviews} reviews`;
}
