import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryDataStore } from '../store/memory.js';

describe('Reputation DataStore methods', () => {
  let store: MemoryDataStore;

  beforeEach(() => {
    store = new MemoryDataStore();
  });

  // ── recordPostedReview / getPostedReviewsByPr ──────────────

  describe('recordPostedReview', () => {
    it('records a posted review and returns an id', async () => {
      const id = await store.recordPostedReview({
        owner: 'test-org',
        repo: 'test-repo',
        pr_number: 42,
        group_id: 'grp-1',
        github_comment_id: 12345,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });
      expect(id).toBeGreaterThan(0);
    });

    it('returns incrementing ids', async () => {
      const id1 = await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g1',
        github_comment_id: 100,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });
      const id2 = await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g2',
        github_comment_id: 200,
        feature: 'review',
        posted_at: '2026-04-01T01:00:00Z',
      });
      expect(id2).toBeGreaterThan(id1);
    });
  });

  describe('getPostedReviewsByPr', () => {
    it('returns reviews matching owner/repo/pr_number', async () => {
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
        feature: 'dedup',
        posted_at: '2026-04-01T01:00:00Z',
      });
      await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 2,
        group_id: 'g3',
        github_comment_id: 300,
        feature: 'review',
        posted_at: '2026-04-01T02:00:00Z',
      });

      const reviews = await store.getPostedReviewsByPr('org', 'repo', 1);
      expect(reviews).toHaveLength(2);
      expect(reviews.map((r) => r.github_comment_id).sort()).toEqual([100, 200]);
    });

    it('returns empty array when no reviews match', async () => {
      const reviews = await store.getPostedReviewsByPr('org', 'repo', 999);
      expect(reviews).toEqual([]);
    });

    it('returns reviews with reactions_checked_at as null initially', async () => {
      await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g1',
        github_comment_id: 100,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });
      const reviews = await store.getPostedReviewsByPr('org', 'repo', 1);
      expect(reviews[0].reactions_checked_at).toBeNull();
    });
  });

  // ── markReactionsChecked ──────────────────────────────────��

  describe('markReactionsChecked', () => {
    it('sets reactions_checked_at on a posted review', async () => {
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

      const reviews = await store.getPostedReviewsByPr('org', 'repo', 1);
      expect(reviews[0].reactions_checked_at).toBe('2026-04-02T00:00:00Z');
    });

    it('is a no-op for nonexistent review id', async () => {
      await store.markReactionsChecked(9999, '2026-04-02T00:00:00Z');
      // should not throw
    });
  });

  // ── recordReputationEvent ─────────────────────────────────

  describe('recordReputationEvent', () => {
    it('records a reputation event', async () => {
      const reviewId = await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g1',
        github_comment_id: 100,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });

      await store.recordReputationEvent({
        posted_review_id: reviewId,
        agent_id: 'agent-1',
        operator_github_user_id: 1000,
        github_user_id: 2000,
        delta: 1,
        created_at: '2026-04-01T01:00:00Z',
      });

      const events = await store.getAgentReputationEvents('agent-1', 0);
      expect(events).toHaveLength(1);
      expect(events[0].delta).toBe(1);
      expect(events[0].agent_id).toBe('agent-1');
      expect(events[0].github_user_id).toBe(2000);
    });

    it('is idempotent — duplicate insert is ignored', async () => {
      const reviewId = await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g1',
        github_comment_id: 100,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });

      const event = {
        posted_review_id: reviewId,
        agent_id: 'agent-1',
        operator_github_user_id: 1000,
        github_user_id: 2000,
        delta: 1,
        created_at: '2026-04-01T01:00:00Z',
      };

      await store.recordReputationEvent(event);
      await store.recordReputationEvent(event); // duplicate

      const events = await store.getAgentReputationEvents('agent-1', 0);
      expect(events).toHaveLength(1);
    });

    it('allows same user to react to different reviews', async () => {
      const reviewId1 = await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g1',
        github_comment_id: 100,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });
      const reviewId2 = await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g2',
        github_comment_id: 200,
        feature: 'review',
        posted_at: '2026-04-01T01:00:00Z',
      });

      await store.recordReputationEvent({
        posted_review_id: reviewId1,
        agent_id: 'agent-1',
        operator_github_user_id: 1000,
        github_user_id: 2000,
        delta: 1,
        created_at: '2026-04-01T01:00:00Z',
      });
      await store.recordReputationEvent({
        posted_review_id: reviewId2,
        agent_id: 'agent-1',
        operator_github_user_id: 1000,
        github_user_id: 2000,
        delta: -1,
        created_at: '2026-04-01T02:00:00Z',
      });

      const events = await store.getAgentReputationEvents('agent-1', 0);
      expect(events).toHaveLength(2);
    });

    it('allows different users to react to same review', async () => {
      const reviewId = await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g1',
        github_comment_id: 100,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });

      await store.recordReputationEvent({
        posted_review_id: reviewId,
        agent_id: 'agent-1',
        operator_github_user_id: 1000,
        github_user_id: 2000,
        delta: 1,
        created_at: '2026-04-01T01:00:00Z',
      });
      await store.recordReputationEvent({
        posted_review_id: reviewId,
        agent_id: 'agent-1',
        operator_github_user_id: 1000,
        github_user_id: 3000,
        delta: -1,
        created_at: '2026-04-01T02:00:00Z',
      });

      const events = await store.getAgentReputationEvents('agent-1', 0);
      expect(events).toHaveLength(2);
    });
  });

  // ── getAgentReputationEvents ──────────────────────────────

  describe('getAgentReputationEvents', () => {
    it('filters by agent_id', async () => {
      const reviewId = await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g1',
        github_comment_id: 100,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });

      await store.recordReputationEvent({
        posted_review_id: reviewId,
        agent_id: 'agent-1',
        operator_github_user_id: 1000,
        github_user_id: 2000,
        delta: 1,
        created_at: '2026-04-01T01:00:00Z',
      });
      await store.recordReputationEvent({
        posted_review_id: reviewId,
        agent_id: 'agent-2',
        operator_github_user_id: 1000,
        github_user_id: 3000,
        delta: -1,
        created_at: '2026-04-01T02:00:00Z',
      });

      const events = await store.getAgentReputationEvents('agent-1', 0);
      expect(events).toHaveLength(1);
      expect(events[0].agent_id).toBe('agent-1');
    });

    it('filters by sinceMs', async () => {
      const reviewId = await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g1',
        github_comment_id: 100,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });

      await store.recordReputationEvent({
        posted_review_id: reviewId,
        agent_id: 'agent-1',
        operator_github_user_id: 1000,
        github_user_id: 2000,
        delta: 1,
        created_at: '2026-01-01T00:00:00Z', // old
      });
      await store.recordReputationEvent({
        posted_review_id: reviewId,
        agent_id: 'agent-1',
        operator_github_user_id: 1000,
        github_user_id: 3000,
        delta: -1,
        created_at: '2026-04-01T00:00:00Z', // recent
      });

      // sinceMs corresponds to 2026-03-01
      const sinceMs = new Date('2026-03-01T00:00:00Z').getTime();
      const events = await store.getAgentReputationEvents('agent-1', sinceMs);
      expect(events).toHaveLength(1);
      expect(events[0].delta).toBe(-1);
    });

    it('returns empty array when no events match', async () => {
      const events = await store.getAgentReputationEvents('nonexistent', 0);
      expect(events).toEqual([]);
    });
  });

  // ── getAccountReputationEvents ────────────────────────────

  describe('getAccountReputationEvents', () => {
    it('filters by operator_github_user_id', async () => {
      const reviewId = await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g1',
        github_comment_id: 100,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });

      await store.recordReputationEvent({
        posted_review_id: reviewId,
        agent_id: 'agent-1',
        operator_github_user_id: 1000,
        github_user_id: 2000,
        delta: 1,
        created_at: '2026-04-01T01:00:00Z',
      });
      await store.recordReputationEvent({
        posted_review_id: reviewId,
        agent_id: 'agent-2',
        operator_github_user_id: 9999,
        github_user_id: 3000,
        delta: -1,
        created_at: '2026-04-01T02:00:00Z',
      });

      const events = await store.getAccountReputationEvents(1000, 0);
      expect(events).toHaveLength(1);
      expect(events[0].operator_github_user_id).toBe(1000);
    });

    it('filters by sinceMs', async () => {
      const reviewId = await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g1',
        github_comment_id: 100,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });

      await store.recordReputationEvent({
        posted_review_id: reviewId,
        agent_id: 'agent-1',
        operator_github_user_id: 1000,
        github_user_id: 2000,
        delta: 1,
        created_at: '2026-01-01T00:00:00Z', // old
      });
      await store.recordReputationEvent({
        posted_review_id: reviewId,
        agent_id: 'agent-1',
        operator_github_user_id: 1000,
        github_user_id: 3000,
        delta: -1,
        created_at: '2026-04-01T00:00:00Z', // recent
      });

      const sinceMs = new Date('2026-03-01T00:00:00Z').getTime();
      const events = await store.getAccountReputationEvents(1000, sinceMs);
      expect(events).toHaveLength(1);
      expect(events[0].delta).toBe(-1);
    });

    it('returns empty array when no events match', async () => {
      const events = await store.getAccountReputationEvents(9999, 0);
      expect(events).toEqual([]);
    });
  });

  // ── countAccountRejections ────────────────────────────────

  describe('countAccountRejections', () => {
    it('counts rejections across all agents for a github user', async () => {
      const now = Date.now();
      await store.recordAgentRejection('agent-1', 'too_short', now, 1000);
      await store.recordAgentRejection('agent-2', 'too_long', now, 1000);
      await store.recordAgentRejection('agent-3', 'too_short', now, 2000);

      const count = await store.countAccountRejections(1000, now - 1000);
      expect(count).toBe(2);
    });

    it('filters by sinceMs', async () => {
      const now = Date.now();
      const old = now - 100_000;
      await store.recordAgentRejection('agent-1', 'too_short', old, 1000);
      await store.recordAgentRejection('agent-2', 'too_long', now, 1000);

      const count = await store.countAccountRejections(1000, now - 1000);
      expect(count).toBe(1);
    });

    it('returns 0 when no rejections match', async () => {
      const count = await store.countAccountRejections(9999, 0);
      expect(count).toBe(0);
    });

    it('does not count rejections without github_user_id', async () => {
      const now = Date.now();
      await store.recordAgentRejection('agent-1', 'too_short', now);
      await store.recordAgentRejection('agent-2', 'too_long', now, 1000);

      const count = await store.countAccountRejections(1000, now - 1000);
      expect(count).toBe(1);
    });
  });

  // ── recordAgentRejection with github_user_id ──────────────

  describe('recordAgentRejection with github_user_id', () => {
    it('records rejection with github_user_id', async () => {
      const now = Date.now();
      await store.recordAgentRejection('agent-1', 'too_short', now, 1000);

      // Agent-level count still works
      const agentCount = await store.countAgentRejections('agent-1', now - 1000);
      expect(agentCount).toBe(1);

      // Account-level count works
      const accountCount = await store.countAccountRejections(1000, now - 1000);
      expect(accountCount).toBe(1);
    });

    it('records rejection without github_user_id (backward compatible)', async () => {
      const now = Date.now();
      await store.recordAgentRejection('agent-1', 'too_short', now);

      const agentCount = await store.countAgentRejections('agent-1', now - 1000);
      expect(agentCount).toBe(1);
    });
  });

  // ── reset clears reputation data ──────────────────────────

  describe('reset clears reputation data', () => {
    it('clears posted reviews', async () => {
      await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g1',
        github_comment_id: 100,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });
      store.reset();
      const reviews = await store.getPostedReviewsByPr('org', 'repo', 1);
      expect(reviews).toEqual([]);
    });

    it('clears reputation events', async () => {
      const id = await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g1',
        github_comment_id: 100,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });
      await store.recordReputationEvent({
        posted_review_id: id,
        agent_id: 'agent-1',
        operator_github_user_id: 1000,
        github_user_id: 2000,
        delta: 1,
        created_at: '2026-04-01T01:00:00Z',
      });
      store.reset();
      const events = await store.getAgentReputationEvents('agent-1', 0);
      expect(events).toEqual([]);
    });

    it('resets posted review id counter', async () => {
      await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g1',
        github_comment_id: 100,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });
      store.reset();
      const id = await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 2,
        group_id: 'g2',
        github_comment_id: 200,
        feature: 'review',
        posted_at: '2026-04-02T00:00:00Z',
      });
      expect(id).toBe(1);
    });
  });

  // ── cleanupStaleReputationEvents ──────────────────────────

  describe('cleanupStaleReputationEvents', () => {
    it('prunes events older than the cutoff and keeps recent ones', async () => {
      const reviewId = await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g1',
        github_comment_id: 100,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });
      const cutoffMs = new Date('2026-04-01T00:00:00Z').getTime();
      const oldIso = new Date(cutoffMs - 60_000).toISOString();
      const recentIso = new Date(cutoffMs + 60_000).toISOString();
      await store.recordReputationEvent({
        posted_review_id: reviewId,
        agent_id: 'agent-A',
        operator_github_user_id: 1000,
        github_user_id: 2000,
        delta: 1,
        created_at: oldIso,
      });
      await store.recordReputationEvent({
        posted_review_id: reviewId,
        agent_id: 'agent-A',
        operator_github_user_id: 1001,
        github_user_id: 2001,
        delta: 1,
        created_at: recentIso,
      });

      const deleted = await store.cleanupStaleReputationEvents(cutoffMs);
      expect(deleted).toBe(1);

      const remaining = await store.getAgentReputationEvents('agent-A', 0);
      expect(remaining).toHaveLength(1);
      expect(remaining[0].created_at).toBe(recentIso);
    });

    it('returns 0 when there are no events', async () => {
      expect(await store.cleanupStaleReputationEvents(Date.now())).toBe(0);
    });

    it('returns 0 when no events are older than the cutoff', async () => {
      const reviewId = await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g1',
        github_comment_id: 100,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });
      const createdAt = '2026-04-01T01:00:00Z';
      await store.recordReputationEvent({
        posted_review_id: reviewId,
        agent_id: 'agent-A',
        operator_github_user_id: 1000,
        github_user_id: 2000,
        delta: 1,
        created_at: createdAt,
      });

      const cutoff = new Date('2026-03-01T00:00:00Z').getTime();
      const deleted = await store.cleanupStaleReputationEvents(cutoff);
      expect(deleted).toBe(0);
      const events = await store.getAgentReputationEvents('agent-A', 0);
      expect(events).toHaveLength(1);
    });

    it('does not prune events exactly at the cutoff boundary', async () => {
      const reviewId = await store.recordPostedReview({
        owner: 'org',
        repo: 'repo',
        pr_number: 1,
        group_id: 'g1',
        github_comment_id: 100,
        feature: 'review',
        posted_at: '2026-04-01T00:00:00Z',
      });
      const boundaryMs = new Date('2026-04-01T00:00:00.000Z').getTime();
      const boundaryIso = new Date(boundaryMs).toISOString();
      await store.recordReputationEvent({
        posted_review_id: reviewId,
        agent_id: 'agent-A',
        operator_github_user_id: 1000,
        github_user_id: 2000,
        delta: 1,
        created_at: boundaryIso,
      });
      // Cutoff equal to the event's timestamp — event survives (>= cutoff kept).
      const deleted = await store.cleanupStaleReputationEvents(boundaryMs);
      expect(deleted).toBe(0);
      const events = await store.getAgentReputationEvents('agent-A', 0);
      expect(events).toHaveLength(1);
    });
  });
});
