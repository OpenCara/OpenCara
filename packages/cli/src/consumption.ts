import type { ConsumptionStatsResponse } from '@opencara/shared';
import type { ConsumptionLimits } from './config.js';
import { ApiClient } from './http.js';

export interface LimitCheckResult {
  allowed: boolean;
  reason?: string;
}

export async function fetchConsumptionStats(
  client: ApiClient,
  agentId: string,
): Promise<ConsumptionStatsResponse> {
  return client.get<ConsumptionStatsResponse>(`/api/consumption/${agentId}`);
}

export async function checkConsumptionLimits(
  client: ApiClient,
  agentId: string,
  limits: ConsumptionLimits | null,
): Promise<LimitCheckResult> {
  if (!limits) return { allowed: true };

  let stats: ConsumptionStatsResponse;
  try {
    stats = await fetchConsumptionStats(client, agentId);
  } catch {
    console.warn('Warning: Could not fetch consumption stats, skipping limit check');
    return { allowed: true };
  }

  if (limits.tokens_per_day && stats.period.last24h.tokens >= limits.tokens_per_day) {
    return {
      allowed: false,
      reason: `Daily token limit reached (${stats.period.last24h.tokens.toLocaleString()}/${limits.tokens_per_day.toLocaleString()})`,
    };
  }
  if (limits.tokens_per_month && stats.period.last30d.tokens >= limits.tokens_per_month) {
    return {
      allowed: false,
      reason: `Monthly token limit reached (${stats.period.last30d.tokens.toLocaleString()}/${limits.tokens_per_month.toLocaleString()})`,
    };
  }
  if (limits.reviews_per_day && stats.period.last24h.reviews >= limits.reviews_per_day) {
    return {
      allowed: false,
      reason: `Daily review limit reached (${stats.period.last24h.reviews}/${limits.reviews_per_day})`,
    };
  }
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
  tokensUsed: number,
  session: SessionStats,
  limits: ConsumptionLimits | null,
  dailyStats?: { tokens: number; reviews: number },
): string {
  const lines: string[] = [];
  lines.push(`  Session: ${session.tokens.toLocaleString()} tokens / ${session.reviews} reviews`);

  if (dailyStats && limits?.tokens_per_day) {
    const pct = ((dailyStats.tokens / limits.tokens_per_day) * 100).toFixed(1);
    lines.push(
      `  Daily:   ${dailyStats.tokens.toLocaleString()} / ${limits.tokens_per_day.toLocaleString()} tokens (${pct}%)`,
    );
  } else if (dailyStats) {
    lines.push(
      `  Daily:   ${dailyStats.tokens.toLocaleString()} tokens / ${dailyStats.reviews} reviews`,
    );
  }

  return lines.join('\n');
}
