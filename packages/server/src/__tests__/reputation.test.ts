import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  wilsonScore,
  decayWeight,
  computeAgentReputation,
  reputationMultiplier,
  cooldownMultiplier,
  effectiveGracePeriod,
  collectReputationReactions,
} from '../reputation.js';
import { MemoryDataStore } from '../store/memory.js';
import type { GitHubService } from '../github/service.js';
import type { TaskClaim, ReviewTask } from '@opencara/shared';
import type { Logger } from '../logger.js';

// ── wilsonScore ────────────────────────────────────────────────

describe('wilsonScore', () => {
  it('cold start (0,0) ≈ 0.15', () => {
    // With Beta(2,2) prior, n=4, p=0.5, Wilson lower bound ≈ 0.15
    expect(wilsonScore(0, 0)).toBeCloseTo(0.15, 1);
  });

  it('few good (3,0) ≈ 0.36', () => {
    // n=7, p=5/7, lower bound ≈ 0.36
    expect(wilsonScore(3, 0)).toBeCloseTo(0.36, 1);
  });

  it('proven good (50,5) ≈ 0.81', () => {
    expect(wilsonScore(50, 5)).toBeCloseTo(0.81, 1);
  });

  it('mixed (100,80) ≈ 0.49', () => {
    expect(wilsonScore(100, 80)).toBeCloseTo(0.49, 1);
  });

  it('proven bad (5,50) ≈ 0.06', () => {
    expect(wilsonScore(5, 50)).toBeCloseTo(0.06, 1);
  });

  it('returns value in [0, 1]', () => {
    const score = wilsonScore(1000, 0);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('increases monotonically with more upvotes', () => {
    const s1 = wilsonScore(5, 0);
    const s2 = wilsonScore(10, 0);
    const s3 = wilsonScore(50, 0);
    expect(s2).toBeGreaterThan(s1);
    expect(s3).toBeGreaterThan(s2);
  });

  it('decreases monotonically with more downvotes', () => {
    const s1 = wilsonScore(5, 0);
    const s2 = wilsonScore(5, 5);
    const s3 = wilsonScore(5, 50);
    expect(s2).toBeLessThan(s1);
    expect(s3).toBeLessThan(s2);
  });
});

// ── decayWeight ────────────────────────────────────────────────

describe('decayWeight', () => {
  it('weight at age 0 = 1.0', () => {
    expect(decayWeight(0)).toBe(1.0);
  });

  it('weight at 14 days = 0.5', () => {
    const fourteenDays = 14 * 24 * 60 * 60 * 1000;
    expect(decayWeight(fourteenDays)).toBeCloseTo(0.5, 5);
  });

  it('weight at 28 days = 0.25', () => {
    const twentyEightDays = 28 * 24 * 60 * 60 * 1000;
    expect(decayWeight(twentyEightDays)).toBeCloseTo(0.25, 5);
  });

  it('weight at 60 days < 0.06', () => {
    const sixtyDays = 60 * 24 * 60 * 60 * 1000;
    expect(decayWeight(sixtyDays)).toBeLessThan(0.06);
  });

  it('always returns positive value', () => {
    const oneYear = 365 * 24 * 60 * 60 * 1000;
    expect(decayWeight(oneYear)).toBeGreaterThan(0);
  });
});

// ── computeAgentReputation ─────────────────────────────────────

describe('computeAgentReputation', () => {
  it('returns cold-start score with no events', () => {
    // Same as wilsonScore(0, 0) ≈ 0.15
    expect(computeAgentReputation([])).toBeCloseTo(0.15, 1);
  });

  it('weights recent upvotes more than old ones', () => {
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000).toISOString(); // 28 days ago

    const recentOnly = computeAgentReputation([
      {
        id: 1,
        posted_review_id: 1,
        agent_id: 'a',
        operator_github_user_id: 1,
        github_user_id: 2,
        delta: 1,
        created_at: now,
      },
    ]);

    const oldOnly = computeAgentReputation([
      {
        id: 2,
        posted_review_id: 1,
        agent_id: 'a',
        operator_github_user_id: 1,
        github_user_id: 2,
        delta: 1,
        created_at: old,
      },
    ]);

    expect(recentOnly).toBeGreaterThan(oldOnly);
  });

  it('downvotes reduce the score', () => {
    const now = new Date().toISOString();
    const upOnly = computeAgentReputation([
      {
        id: 1,
        posted_review_id: 1,
        agent_id: 'a',
        operator_github_user_id: 1,
        github_user_id: 2,
        delta: 1,
        created_at: now,
      },
    ]);
    const mixed = computeAgentReputation([
      {
        id: 1,
        posted_review_id: 1,
        agent_id: 'a',
        operator_github_user_id: 1,
        github_user_id: 2,
        delta: 1,
        created_at: now,
      },
      {
        id: 2,
        posted_review_id: 1,
        agent_id: 'a',
        operator_github_user_id: 1,
        github_user_id: 3,
        delta: -1,
        created_at: now,
      },
    ]);

    expect(mixed).toBeLessThan(upOnly);
  });
});

// ── reputationMultiplier ───────────────────────────────────────

describe('reputationMultiplier', () => {
  it('proven good (0.81) → 0.5', () => {
    expect(reputationMultiplier(0.81)).toBe(0.5);
  });

  it('threshold good (0.7) → 0.5', () => {
    expect(reputationMultiplier(0.7)).toBe(0.5);
  });

  it('neutral (0.50) → 1.0', () => {
    expect(reputationMultiplier(0.5)).toBe(1.0);
  });

  it('threshold neutral (0.4) → 1.0', () => {
    expect(reputationMultiplier(0.4)).toBe(1.0);
  });

  it('bad (0.20) → exponential penalty ≈ 3.2', () => {
    const m = reputationMultiplier(0.2);
    expect(m).toBeCloseTo(3.0, 0); // 3^((0.4-0.2)*5) = 3^1 = 3
  });

  it('very bad (0.06) → large penalty', () => {
    const m = reputationMultiplier(0.06);
    // 3^((0.4-0.06)*5) = 3^1.7 ≈ 6.47
    expect(m).toBeGreaterThan(5);
  });

  it('at zero → maximum penalty', () => {
    const m = reputationMultiplier(0);
    // 3^((0.4)*5) = 3^2 = 9
    expect(m).toBeCloseTo(9.0, 1);
  });

  it('monotonically decreasing as score increases (penalty → neutral → boost)', () => {
    const scores = [0.1, 0.2, 0.3, 0.39, 0.4, 0.5, 0.69, 0.7, 0.8, 0.9];
    for (let i = 1; i < scores.length; i++) {
      expect(reputationMultiplier(scores[i])).toBeLessThanOrEqual(
        reputationMultiplier(scores[i - 1]),
      );
    }
  });
});

// ── cooldownMultiplier ─────────────────────────────────────────

describe('cooldownMultiplier', () => {
  it('null → 1.0', () => {
    expect(cooldownMultiplier(null)).toBe(1.0);
  });

  it('>= 10min ago → 1.0', () => {
    expect(cooldownMultiplier(Date.now() - 11 * 60_000)).toBe(1.0);
  });

  it('exactly 10min ago → 1.0', () => {
    expect(cooldownMultiplier(Date.now() - 10 * 60_000)).toBe(1.0);
  });

  it('7min ago → 1.5', () => {
    expect(cooldownMultiplier(Date.now() - 7 * 60_000)).toBe(1.5);
  });

  it('exactly 5min ago → 1.5', () => {
    expect(cooldownMultiplier(Date.now() - 5 * 60_000)).toBe(1.5);
  });

  it('1min ago → 2.0', () => {
    expect(cooldownMultiplier(Date.now() - 1 * 60_000)).toBe(2.0);
  });

  it('just now → 2.0', () => {
    expect(cooldownMultiplier(Date.now())).toBe(2.0);
  });
});

// ── effectiveGracePeriod ───────────────────────────────────────

describe('effectiveGracePeriod', () => {
  const BASE = 30_000; // 30s

  it('idle (fully cooled) → base', () => {
    const result = effectiveGracePeriod(BASE, Date.now() - 15 * 60_000);
    expect(result).toBe(30_000); // 30s * 1.0
  });

  it('just reviewed → doubled', () => {
    const result = effectiveGracePeriod(BASE, Date.now() - 1 * 60_000);
    expect(result).toBe(60_000); // 30s * 2.0
  });

  it('never reviewed → base', () => {
    const result = effectiveGracePeriod(BASE, null);
    expect(result).toBe(30_000); // 30s * 1.0
  });

  it('half-cooled (5–10 min) → 1.5×', () => {
    const result = effectiveGracePeriod(BASE, Date.now() - 7 * 60_000);
    expect(result).toBe(45_000); // 30s * 1.5
  });
});

// ── collectReputationReactions ─────────────────────────────────

describe('collectReputationReactions', () => {
  let store: MemoryDataStore;
  let mockGithub: GitHubService;
  let mockLogger: Logger;

  beforeEach(() => {
    store = new MemoryDataStore();
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;
    mockGithub = {
      getCommentReactions: vi.fn().mockResolvedValue([]),
    } as unknown as GitHubService;
  });

  it('does nothing when no unchecked reviews exist', async () => {
    await collectReputationReactions(store, mockGithub, 'org', 'repo', 1, 'token', mockLogger);
    expect(mockGithub.getCommentReactions).not.toHaveBeenCalled();
  });

  it('skips already-checked reviews', async () => {
    const id = await store.recordPostedReview({
      owner: 'org',
      repo: 'repo',
      pr_number: 1,
      group_id: 'g1',
      github_comment_id: 100,
      feature: 'review',
      posted_at: '2026-04-01T00:00:00Z',
    });
    await store.markReactionsChecked(id, '2026-04-02T00:00:00Z');

    await collectReputationReactions(store, mockGithub, 'org', 'repo', 1, 'token', mockLogger);
    expect(mockGithub.getCommentReactions).not.toHaveBeenCalled();
  });

  it('fetches reactions and records events for thumbs up/down', async () => {
    // Set up a posted review
    await store.recordPostedReview({
      owner: 'org',
      repo: 'repo',
      pr_number: 1,
      group_id: 'g1',
      github_comment_id: 100,
      feature: 'review',
      posted_at: '2026-04-01T00:00:00Z',
    });

    // Set up a completed task+claim in the group
    const task: ReviewTask = {
      id: 'task-1',
      group_id: 'g1',
      owner: 'org',
      repo: 'repo',
      pr_number: 1,
      pr_title: 'Test PR',
      pr_url: 'https://github.com/org/repo/pull/1',
      diff_url: 'https://github.com/org/repo/pull/1.diff',
      base_ref: 'main',
      head_ref: 'feature',
      head_sha: 'abc123',
      pr_author: 'user',
      pr_additions: 10,
      pr_deletions: 5,
      status: 'completed',
      review_claims: 0,
      completed_reviews: 1,
      required_reviews: 1,
      summary_claimed_by: null,
      summary_retry_count: 0,
      task_type: 'review',
      feature: 'review',
      config: '{}',
      timeout_at: Date.now() + 300000,
      created_at: Date.now(),
    };
    await store.createTask(task);

    const claim: TaskClaim = {
      id: 'claim-1',
      task_id: 'task-1',
      agent_id: 'agent-1',
      role: 'review',
      status: 'completed',
      github_user_id: 5000,
      github_username: 'operator',
      created_at: Date.now(),
    };
    await store.createClaim(claim);

    // Mock reactions: one thumbs up, one thumbs down, one heart (ignored)
    (mockGithub.getCommentReactions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { user_id: 2000, content: '+1' },
      { user_id: 3000, content: '-1' },
      { user_id: 4000, content: 'heart' },
    ]);

    await collectReputationReactions(store, mockGithub, 'org', 'repo', 1, 'token', mockLogger);

    // Should have 2 reputation events (thumbs up and thumbs down, not heart)
    const events = await store.getAgentReputationEvents('agent-1', 0);
    expect(events).toHaveLength(2);
    expect(events.find((e) => e.delta === 1)?.github_user_id).toBe(2000);
    expect(events.find((e) => e.delta === -1)?.github_user_id).toBe(3000);

    // Should mark reactions as checked
    const reviews = await store.getPostedReviewsByPr('org', 'repo', 1);
    expect(reviews[0].reactions_checked_at).not.toBeNull();
  });

  it('records events for all contributing agents in the group', async () => {
    await store.recordPostedReview({
      owner: 'org',
      repo: 'repo',
      pr_number: 1,
      group_id: 'g1',
      github_comment_id: 100,
      feature: 'review',
      posted_at: '2026-04-01T00:00:00Z',
    });

    // Two tasks in the same group with different agents
    for (const [taskId, agentId, userId] of [
      ['task-1', 'agent-1', 5000],
      ['task-2', 'agent-2', 6000],
    ] as const) {
      const task: ReviewTask = {
        id: taskId,
        group_id: 'g1',
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        pr_title: 'Test PR',
        pr_url: 'https://github.com/org/repo/pull/1',
        diff_url: 'https://github.com/org/repo/pull/1.diff',
        base_ref: 'main',
        head_ref: 'feature',
        head_sha: 'abc123',
        pr_author: 'user',
        pr_additions: 10,
        pr_deletions: 5,
        status: 'completed',
        review_claims: 0,
        completed_reviews: 1,
        required_reviews: 1,
        summary_claimed_by: null,
        summary_retry_count: 0,
        task_type: 'review',
        feature: 'review',
        config: '{}',
        timeout_at: Date.now() + 300000,
        created_at: Date.now(),
      };
      await store.createTask(task);
      await store.createClaim({
        id: `claim-${taskId}`,
        task_id: taskId,
        agent_id: agentId,
        role: 'review',
        status: 'completed',
        github_user_id: userId,
        github_username: 'operator',
        created_at: Date.now(),
      });
    }

    (mockGithub.getCommentReactions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { user_id: 2000, content: '+1' },
    ]);

    await collectReputationReactions(store, mockGithub, 'org', 'repo', 1, 'token', mockLogger);

    const events1 = await store.getAgentReputationEvents('agent-1', 0);
    const events2 = await store.getAgentReputationEvents('agent-2', 0);
    expect(events1).toHaveLength(1);
    expect(events2).toHaveLength(1);
  });

  it('skips agents without github_user_id on claims', async () => {
    await store.recordPostedReview({
      owner: 'org',
      repo: 'repo',
      pr_number: 1,
      group_id: 'g1',
      github_comment_id: 100,
      feature: 'review',
      posted_at: '2026-04-01T00:00:00Z',
    });

    const task: ReviewTask = {
      id: 'task-1',
      group_id: 'g1',
      owner: 'org',
      repo: 'repo',
      pr_number: 1,
      pr_title: 'Test PR',
      pr_url: 'https://github.com/org/repo/pull/1',
      diff_url: 'https://github.com/org/repo/pull/1.diff',
      base_ref: 'main',
      head_ref: 'feature',
      head_sha: 'abc123',
      pr_author: 'user',
      pr_additions: 10,
      pr_deletions: 5,
      status: 'completed',
      review_claims: 0,
      completed_reviews: 1,
      required_reviews: 1,
      summary_claimed_by: null,
      summary_retry_count: 0,
      task_type: 'review',
      feature: 'review',
      config: '{}',
      timeout_at: Date.now() + 300000,
      created_at: Date.now(),
    };
    await store.createTask(task);

    // Claim without github_user_id
    await store.createClaim({
      id: 'claim-1',
      task_id: 'task-1',
      agent_id: 'agent-1',
      role: 'review',
      status: 'completed',
      created_at: Date.now(),
    });

    (mockGithub.getCommentReactions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { user_id: 2000, content: '+1' },
    ]);

    await collectReputationReactions(store, mockGithub, 'org', 'repo', 1, 'token', mockLogger);

    const events = await store.getAgentReputationEvents('agent-1', 0);
    expect(events).toHaveLength(0);
  });

  it('is idempotent — running twice does not double-count', async () => {
    await store.recordPostedReview({
      owner: 'org',
      repo: 'repo',
      pr_number: 1,
      group_id: 'g1',
      github_comment_id: 100,
      feature: 'review',
      posted_at: '2026-04-01T00:00:00Z',
    });

    const task: ReviewTask = {
      id: 'task-1',
      group_id: 'g1',
      owner: 'org',
      repo: 'repo',
      pr_number: 1,
      pr_title: 'Test PR',
      pr_url: 'https://github.com/org/repo/pull/1',
      diff_url: 'https://github.com/org/repo/pull/1.diff',
      base_ref: 'main',
      head_ref: 'feature',
      head_sha: 'abc123',
      pr_author: 'user',
      pr_additions: 10,
      pr_deletions: 5,
      status: 'completed',
      review_claims: 0,
      completed_reviews: 1,
      required_reviews: 1,
      summary_claimed_by: null,
      summary_retry_count: 0,
      task_type: 'review',
      feature: 'review',
      config: '{}',
      timeout_at: Date.now() + 300000,
      created_at: Date.now(),
    };
    await store.createTask(task);
    await store.createClaim({
      id: 'claim-1',
      task_id: 'task-1',
      agent_id: 'agent-1',
      role: 'review',
      status: 'completed',
      github_user_id: 5000,
      github_username: 'operator',
      created_at: Date.now(),
    });

    (mockGithub.getCommentReactions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { user_id: 2000, content: '+1' },
    ]);

    // First call records events + marks checked
    await collectReputationReactions(store, mockGithub, 'org', 'repo', 1, 'token', mockLogger);

    // Second call — review is already checked, so no new events
    await collectReputationReactions(store, mockGithub, 'org', 'repo', 1, 'token', mockLogger);

    const events = await store.getAgentReputationEvents('agent-1', 0);
    expect(events).toHaveLength(1);
  });

  it('handles reaction fetch errors gracefully per review', async () => {
    // Two unchecked reviews
    await store.recordPostedReview({
      owner: 'org',
      repo: 'repo',
      pr_number: 1,
      group_id: 'g1',
      github_comment_id: 100,
      feature: 'review',
      posted_at: '2026-04-01T00:00:00Z',
    });
    await store.recordPostedReview({
      owner: 'org',
      repo: 'repo',
      pr_number: 1,
      group_id: 'g2',
      github_comment_id: 200,
      feature: 'review',
      posted_at: '2026-04-01T01:00:00Z',
    });

    // First reaction fetch fails, second succeeds
    (mockGithub.getCommentReactions as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('API error'))
      .mockResolvedValueOnce([]);

    await collectReputationReactions(store, mockGithub, 'org', 'repo', 1, 'token', mockLogger);

    expect(mockLogger.error).toHaveBeenCalledOnce();
    // Second review should still be marked as checked
    const reviews = await store.getPostedReviewsByPr('org', 'repo', 1);
    const unchecked = reviews.filter((r) => r.reactions_checked_at === null);
    // First review failed — not checked. Second succeeded — checked.
    expect(unchecked).toHaveLength(1);
    expect(unchecked[0].github_comment_id).toBe(100);
  });

  it('deduplicates agents within a group', async () => {
    await store.recordPostedReview({
      owner: 'org',
      repo: 'repo',
      pr_number: 1,
      group_id: 'g1',
      github_comment_id: 100,
      feature: 'review',
      posted_at: '2026-04-01T00:00:00Z',
    });

    // Two tasks in same group, same agent
    for (const taskId of ['task-1', 'task-2']) {
      const task: ReviewTask = {
        id: taskId,
        group_id: 'g1',
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        pr_title: 'Test PR',
        pr_url: 'https://github.com/org/repo/pull/1',
        diff_url: 'https://github.com/org/repo/pull/1.diff',
        base_ref: 'main',
        head_ref: 'feature',
        head_sha: 'abc123',
        pr_author: 'user',
        pr_additions: 10,
        pr_deletions: 5,
        status: 'completed',
        review_claims: 0,
        completed_reviews: 1,
        required_reviews: 1,
        summary_claimed_by: null,
        summary_retry_count: 0,
        task_type: 'review',
        feature: 'review',
        config: '{}',
        timeout_at: Date.now() + 300000,
        created_at: Date.now(),
      };
      await store.createTask(task);
      await store.createClaim({
        id: `claim-${taskId}`,
        task_id: taskId,
        agent_id: 'agent-1', // same agent
        role: 'review',
        status: 'completed',
        github_user_id: 5000,
        github_username: 'operator',
        created_at: Date.now(),
      });
    }

    (mockGithub.getCommentReactions as ReturnType<typeof vi.fn>).mockResolvedValue([
      { user_id: 2000, content: '+1' },
    ]);

    await collectReputationReactions(store, mockGithub, 'org', 'repo', 1, 'token', mockLogger);

    // Should only have 1 event, not 2 (agent deduplicated)
    const events = await store.getAgentReputationEvents('agent-1', 0);
    expect(events).toHaveLength(1);
  });
});
