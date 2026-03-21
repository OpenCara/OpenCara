import type { ReviewConfig, RepoConfig, ClaimRole } from '@opencara/shared';

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
    console.warn(`Invalid glob pattern in skip config: "${pattern}"`);
    return false;
  }
}

/**
 * Check if an agent is eligible for a given role based on the review config's
 * whitelist/blacklist settings. Blacklist is checked first (deny takes priority).
 */
export function isAgentEligibleForRole(
  config: ReviewConfig,
  role: ClaimRole,
  agentId: string,
): { eligible: boolean; reason?: string } {
  const roleConfig = role === 'review' ? config.reviewer : config.summarizer;
  const { whitelist, blacklist } = roleConfig;

  // Blacklist check — deny takes priority
  if (blacklist.length > 0) {
    const blocked = blacklist.some((entry) => entry.agent === agentId);
    if (blocked) {
      return { eligible: false, reason: `Agent "${agentId}" is blacklisted for ${role}` };
    }
  }

  // Whitelist check — if non-empty, only listed agents are allowed
  if (whitelist.length > 0) {
    const agentEntries = whitelist.filter((entry) => entry.agent);
    const allowed = agentEntries.some((entry) => entry.agent === agentId);
    if (!allowed) {
      // For reviewers, check allowAnonymous — if the agent isn't in the whitelist,
      // they're blocked regardless of allowAnonymous (allowAnonymous controls
      // agents without IDs, but all poll/claim requests require agent_id)
      return { eligible: false, reason: `Agent "${agentId}" is not in the ${role} whitelist` };
    }
  }

  // For reviewers with allowAnonymous: false and a non-empty whitelist,
  // the whitelist check above already handles it. When the whitelist is empty
  // and allowAnonymous is false, we still allow agents with IDs (they're known agents).
  // allowAnonymous only matters for future anonymous agent support.

  return { eligible: true };
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
