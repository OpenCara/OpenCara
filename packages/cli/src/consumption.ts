import type { ConsumptionLimits } from './config.js';

export interface LimitCheckResult {
  allowed: boolean;
  reason?: string;
}

/**
 * Consumption tracking was removed (consumption_logs table dropped).
 * Limit checks always pass since token counts are self-reported and not stored server-side.
 */
export async function checkConsumptionLimits(
  _agentId: string,
  _limits: ConsumptionLimits | null,
): Promise<LimitCheckResult> {
  return { allowed: true };
}

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

export function formatPostReviewStats(
  _tokensUsed: number,
  session: SessionStats,
  _limits: ConsumptionLimits | null,
  _dailyStats?: { tokens: number; reviews: number },
): string {
  return `  Session: ${session.tokens.toLocaleString()} tokens / ${session.reviews} reviews`;
}
