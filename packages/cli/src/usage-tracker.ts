import * as fs from 'node:fs';
import * as path from 'node:path';
import { CONFIG_DIR, ensureConfigDir } from './config.js';
import type { UsageLimits } from './config.js';

export const USAGE_FILE = path.join(CONFIG_DIR, 'usage.json');
const MAX_HISTORY_DAYS = 30;
const WARNING_THRESHOLD = 0.8;

export interface DailyTokens {
  input: number;
  output: number;
  estimated: number;
}

export interface DailyUsage {
  date: string; // YYYY-MM-DD local time
  reviews: number;
  tokens: DailyTokens;
}

export interface UsageData {
  days: DailyUsage[];
}

export type LimitStatus = { allowed: true; warning?: string } | { allowed: false; reason: string };

function todayKey(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function totalTokens(t: DailyTokens): number {
  return t.input + t.output + t.estimated;
}

export class UsageTracker {
  private data: UsageData;
  private filePath: string;

  constructor(filePath: string = USAGE_FILE) {
    this.filePath = filePath;
    this.data = this.load();
    this.pruneHistory();
  }

  private load(): UsageData {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf-8');
        const parsed = JSON.parse(raw) as UsageData;
        if (parsed && Array.isArray(parsed.days)) {
          return parsed;
        }
      }
    } catch {
      // Corrupt or missing file — start fresh
    }
    return { days: [] };
  }

  save(): void {
    ensureConfigDir();
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), {
      encoding: 'utf-8',
      mode: 0o600,
    });
  }

  /** Get or create today's usage record. Prunes old history. */
  getToday(): DailyUsage {
    const key = todayKey();
    let today = this.data.days.find((d) => d.date === key);
    if (!today) {
      today = { date: key, reviews: 0, tokens: { input: 0, output: 0, estimated: 0 } };
      this.data.days.push(today);
      this.pruneHistory();
    }
    return today;
  }

  /** Record a completed review with its token usage. */
  recordReview(tokens: { input: number; output: number; estimated: boolean }): void {
    const today = this.getToday();
    today.reviews += 1;
    if (tokens.estimated) {
      today.tokens.estimated += tokens.input + tokens.output;
    } else {
      today.tokens.input += tokens.input;
      today.tokens.output += tokens.output;
    }
    this.save();
  }

  /** Check whether a new review is allowed under the configured limits. */
  checkLimits(limits: UsageLimits): LimitStatus {
    const today = this.getToday();
    const todayTokenTotal = totalTokens(today.tokens);

    // Check review cap
    if (limits.maxReviewsPerDay !== null && today.reviews >= limits.maxReviewsPerDay) {
      return {
        allowed: false,
        reason: `Daily review limit reached (${today.reviews}/${limits.maxReviewsPerDay})`,
      };
    }

    // Check token budget
    if (limits.maxTokensPerDay !== null && todayTokenTotal >= limits.maxTokensPerDay) {
      return {
        allowed: false,
        reason: `Daily token budget exhausted (${todayTokenTotal.toLocaleString()}/${limits.maxTokensPerDay.toLocaleString()})`,
      };
    }

    // Check 80% warnings
    const warnings: string[] = [];
    if (limits.maxReviewsPerDay !== null) {
      const ratio = today.reviews / limits.maxReviewsPerDay;
      if (ratio >= WARNING_THRESHOLD) {
        warnings.push(
          `Reviews: ${today.reviews}/${limits.maxReviewsPerDay} (${Math.round(ratio * 100)}%)`,
        );
      }
    }
    if (limits.maxTokensPerDay !== null) {
      const ratio = todayTokenTotal / limits.maxTokensPerDay;
      if (ratio >= WARNING_THRESHOLD) {
        warnings.push(
          `Tokens: ${todayTokenTotal.toLocaleString()}/${limits.maxTokensPerDay.toLocaleString()} (${Math.round(ratio * 100)}%)`,
        );
      }
    }

    return { allowed: true, warning: warnings.length > 0 ? warnings.join('; ') : undefined };
  }

  /** Check whether a specific review's estimated token count exceeds the per-review limit. */
  checkPerReviewLimit(estimatedTokens: number, limits: UsageLimits): LimitStatus {
    if (limits.maxTokensPerReview !== null && estimatedTokens > limits.maxTokensPerReview) {
      return {
        allowed: false,
        reason: `Estimated tokens (${estimatedTokens.toLocaleString()}) exceed per-review limit (${limits.maxTokensPerReview.toLocaleString()})`,
      };
    }
    return { allowed: true };
  }

  /** Remove entries older than MAX_HISTORY_DAYS. */
  private pruneHistory(): void {
    if (this.data.days.length <= MAX_HISTORY_DAYS) return;
    // Keep only the most recent MAX_HISTORY_DAYS entries (sorted by date descending)
    this.data.days.sort((a, b) => b.date.localeCompare(a.date));
    this.data.days = this.data.days.slice(0, MAX_HISTORY_DAYS);
  }

  /** Format a usage summary for display on shutdown. */
  formatSummary(limits: UsageLimits): string {
    const today = this.getToday();
    const todayTokenTotal = totalTokens(today.tokens);
    const lines: string[] = ['Usage Summary:'];
    lines.push(`  Date: ${today.date}`);
    lines.push(
      `  Reviews: ${today.reviews}${limits.maxReviewsPerDay !== null ? `/${limits.maxReviewsPerDay}` : ''}`,
    );

    const tokenParts: string[] = [];
    if (today.tokens.input > 0) tokenParts.push(`${today.tokens.input.toLocaleString()} in`);
    if (today.tokens.output > 0) tokenParts.push(`${today.tokens.output.toLocaleString()} out`);
    if (today.tokens.estimated > 0)
      tokenParts.push(`${today.tokens.estimated.toLocaleString()} est`);
    const breakdown = tokenParts.length > 0 ? ` (${tokenParts.join(' + ')})` : '';
    lines.push(
      `  Tokens: ${todayTokenTotal.toLocaleString()}${limits.maxTokensPerDay !== null ? `/${limits.maxTokensPerDay.toLocaleString()}` : ''}${breakdown}`,
    );

    if (limits.maxTokensPerDay !== null) {
      const remaining = Math.max(0, limits.maxTokensPerDay - todayTokenTotal);
      lines.push(`  Remaining token budget: ${remaining.toLocaleString()}`);
    }
    if (limits.maxReviewsPerDay !== null) {
      const remaining = Math.max(0, limits.maxReviewsPerDay - today.reviews);
      lines.push(`  Remaining reviews: ${remaining}`);
    }

    return lines.join('\n');
  }

  /** Get all stored usage data (for testing/inspection). */
  getData(): UsageData {
    return this.data;
  }
}
