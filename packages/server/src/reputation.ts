import type { DataStore, ReputationEvent } from './store/interface.js';
import type { GitHubService } from './github/service.js';
import type { Logger } from './logger.js';
import {
  REPUTATION_PRIOR_UP,
  REPUTATION_PRIOR_DOWN,
  REPUTATION_DECAY_HALF_LIFE_MS,
  REPUTATION_GOOD_THRESHOLD,
  REPUTATION_NEUTRAL_THRESHOLD,
  COOLDOWN_FULL_MS,
  COOLDOWN_HALF_MS,
} from './store/constants.js';

/**
 * Wilson score lower bound with Beta(2,2) Bayesian prior.
 * Returns a value in [0, 1].
 */
export function wilsonScore(upvotes: number, downvotes: number): number {
  const n = REPUTATION_PRIOR_UP + REPUTATION_PRIOR_DOWN + upvotes + downvotes;
  const p = (REPUTATION_PRIOR_UP + upvotes) / n;
  const z = 1.96; // 95% confidence
  return (
    (p + (z * z) / (2 * n) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) /
    (1 + (z * z) / n)
  );
}

/**
 * Exponential decay weight based on event age. 14-day half-life.
 * Returns a value in (0, 1].
 */
export function decayWeight(eventAgeMs: number): number {
  return Math.pow(0.5, eventAgeMs / REPUTATION_DECAY_HALF_LIFE_MS);
}

/**
 * Compute decayed Wilson score from reputation events.
 * Weights each event by decayWeight(), sums weighted upvotes/downvotes,
 * then returns wilsonScore(weightedUp, weightedDown).
 */
export function computeAgentReputation(events: ReputationEvent[]): number {
  const now = Date.now();
  let up = 0;
  let down = 0;
  for (const e of events) {
    const age = now - new Date(e.created_at).getTime();
    const w = decayWeight(age);
    if (e.delta > 0) up += w;
    else down += w;
  }
  return wilsonScore(up, down);
}

/**
 * Map Wilson score to a grace period multiplier.
 * - >= 0.7: 0.5 (priority boost)
 * - >= 0.4: 1.0 (default)
 * - < 0.4: exponential penalty
 */
export function reputationMultiplier(score: number): number {
  if (score >= REPUTATION_GOOD_THRESHOLD) return 0.5;
  if (score >= REPUTATION_NEUTRAL_THRESHOLD) return 1.0;
  return Math.pow(3, (REPUTATION_NEUTRAL_THRESHOLD - score) * 5);
}

/**
 * Recency-based cooldown multiplier.
 * - null or >= 10min ago: 1.0
 * - >= 5min ago: 1.5
 * - < 5min ago: 2.0
 */
export function cooldownMultiplier(lastReviewAt: number | null): number {
  if (lastReviewAt === null) return 1.0;
  const elapsed = Date.now() - lastReviewAt;
  if (elapsed >= COOLDOWN_FULL_MS) return 1.0;
  if (elapsed >= COOLDOWN_HALF_MS) return 1.5;
  return 2.0;
}

/**
 * Combined effective grace period applying both reputation and cooldown multipliers.
 */
export function effectiveGracePeriod(
  baseMs: number,
  score: number,
  lastReviewAt: number | null,
): number {
  return baseMs * reputationMultiplier(score) * cooldownMultiplier(lastReviewAt);
}

/**
 * Fetch reactions from posted review comments for a PR, resolve contributing
 * agents, and record reputation events.
 *
 * Called on `pull_request.closed` webhook event.
 */
export async function collectReputationReactions(
  store: DataStore,
  github: GitHubService,
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
  logger: Logger,
): Promise<void> {
  const reviews = await store.getPostedReviewsByPr(owner, repo, prNumber);
  const unchecked = reviews.filter((r) => r.reactions_checked_at === null);

  if (unchecked.length === 0) {
    logger.info('No unchecked reviews for reputation collection', { owner, repo, prNumber });
    return;
  }

  const now = new Date().toISOString();

  for (const review of unchecked) {
    try {
      const reactions = await github.getCommentReactions(
        owner,
        repo,
        review.github_comment_id,
        token,
      );

      // Filter to thumbs up/down only
      const relevant = reactions.filter((r) => r.content === '+1' || r.content === '-1');

      if (relevant.length > 0) {
        // Resolve contributing agents from the group's claims
        const groupTasks = await store.getTasksByGroup(review.group_id);
        const agents: Array<{ agent_id: string; operator_github_user_id: number }> = [];

        for (const task of groupTasks) {
          const claims = await store.getClaims(task.id);
          for (const claim of claims) {
            if (claim.status === 'completed' && claim.github_user_id) {
              // Deduplicate by agent_id
              if (!agents.some((a) => a.agent_id === claim.agent_id)) {
                agents.push({
                  agent_id: claim.agent_id,
                  operator_github_user_id: claim.github_user_id,
                });
              }
            }
          }
        }

        // Record reputation events for each agent + reaction combo
        for (const agent of agents) {
          for (const reaction of relevant) {
            const delta = reaction.content === '+1' ? 1 : -1;
            await store.recordReputationEvent({
              posted_review_id: review.id,
              agent_id: agent.agent_id,
              operator_github_user_id: agent.operator_github_user_id,
              github_user_id: reaction.user_id,
              delta,
              created_at: now,
            });
          }
        }

        logger.info('Recorded reputation events from reactions', {
          owner,
          repo,
          prNumber,
          reviewId: review.id,
          reactionCount: relevant.length,
          agentCount: agents.length,
        });
      }

      await store.markReactionsChecked(review.id, now);
    } catch (err) {
      logger.error('Failed to collect reactions for review', {
        error: err instanceof Error ? err.message : String(err),
        reviewId: review.id,
        owner,
        repo,
        prNumber,
      });
    }
  }
}
