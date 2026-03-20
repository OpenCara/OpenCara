import type { ReviewConfig, RepoConfig } from '@opencara/shared';

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
    return false;
  }
}

/** Parse timeout string (e.g., "10m") to milliseconds. */
export function parseTimeoutMs(timeout: string): number {
  const match = timeout.match(/^(\d+)m$/);
  if (!match) return 10 * 60 * 1000;
  return parseInt(match[1], 10) * 60 * 1000;
}

/**
 * Check if an agent's repo config allows reviewing a given repo.
 */
export function isRepoAllowed(
  repoConfig: RepoConfig | null | undefined,
  targetOwner: string,
  targetRepo: string,
  agentOwner?: string,
): boolean {
  if (!repoConfig) return true; // null = accept all
  const fullRepo = `${targetOwner}/${targetRepo}`;
  switch (repoConfig.mode) {
    case 'all':
      return true;
    case 'own':
      return agentOwner === targetOwner;
    case 'whitelist':
      return (repoConfig.list ?? []).includes(fullRepo);
    case 'blacklist':
      return !(repoConfig.list ?? []).includes(fullRepo);
    default:
      return true;
  }
}
