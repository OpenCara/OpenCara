import type { ReviewConfig, TaskRole } from '@opencara/shared';
import { isEntityMatch } from '@opencara/shared';
import { createLogger } from './logger.js';
export { isRepoAllowed } from '@opencara/shared';

/**
 * Check if the PR should be skipped based on trigger.skip conditions.
 */
export function shouldSkipReview(
  config: ReviewConfig,
  pr: { draft?: boolean; labels?: Array<{ name: string }>; headRef: string },
): string | null {
  for (const condition of config.trigger.skip) {
    if (condition === 'draft' && pr.draft) {
      return 'PR is a draft';
    }
    if (condition.startsWith('label:')) {
      const labelName = condition.slice(6);
      if (pr.labels?.some((l) => l.name === labelName)) {
        return `PR has label "${labelName}"`;
      }
    }
    if (condition.startsWith('branch:')) {
      const pattern = condition.slice(7);
      if (matchGlob(pattern, pr.headRef)) {
        return `Branch "${pr.headRef}" matches skip pattern "${pattern}"`;
      }
    }
  }
  return null;
}

/**
 * Simple glob matching: supports * as wildcard.
 */
function matchGlob(pattern: string, text: string): boolean {
  try {
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    return new RegExp('^' + escaped + '$').test(text);
  } catch {
    createLogger().warn('Invalid glob pattern in skip config', { pattern });
    return false;
  }
}

/**
 * Check if an agent is eligible for a given role based on the review config's
 * whitelist/blacklist settings. Blacklist is checked first (deny takes priority).
 *
 * Matching uses isEntityMatch() from shared — entries with `agent` field match
 * against agentId, entries with `github` field match against githubUsername
 * (case-insensitive).
 */
export function isAgentEligibleForRole(
  config: ReviewConfig,
  role: TaskRole,
  agentId: string,
  githubUsername?: string,
): { eligible: boolean; reason?: string } {
  const roleConfig = role === 'review' ? config.reviewer : config.summarizer;
  const { whitelist, blacklist } = roleConfig;

  // Blacklist check — deny takes priority
  if (blacklist.length > 0) {
    const blocked = blacklist.some((entry) => isEntityMatch(entry, agentId, githubUsername));
    if (blocked) {
      return { eligible: false, reason: `Agent "${agentId}" is blacklisted for ${role}` };
    }
  }

  // Whitelist check — if non-empty, only listed agents/users are allowed
  if (whitelist.length > 0) {
    const allowed = whitelist.some((entry) => isEntityMatch(entry, agentId, githubUsername));
    if (!allowed) {
      return { eligible: false, reason: `Agent "${agentId}" is not in the ${role} whitelist` };
    }
  }

  return { eligible: true };
}

/** Parse timeout string (e.g., "10m") to milliseconds. */
export function parseTimeoutMs(timeout: string): number {
  const match = timeout.match(/^(\d+)m$/);
  if (!match) return 10 * 60 * 1000;
  return parseInt(match[1], 10) * 60 * 1000;
}
