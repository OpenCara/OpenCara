import { describe, it, expect } from 'vitest';
import type { ReviewTask, TaskClaim } from '@opencara/shared';
import { DEFAULT_REVIEW_CONFIG } from '@opencara/shared';
import {
  isTaskActive,
  isTaskTerminal,
  isInReviewQueue,
  isInSummaryQueue,
  isSummaryClaimed,
  isTimedOut,
  isClaimPending,
  isClaimTerminal,
  isClaimFailed,
  isCompletedReview,
  shouldTransitionToSummary,
} from '../task-lifecycle.js';

function makeTask(overrides: Partial<ReviewTask> = {}): ReviewTask {
  return {
    id: 'task-1',
    owner: 'test-owner',
    repo: 'test-repo',
    pr_number: 1,
    pr_url: 'https://github.com/test/repo/pull/1',
    diff_url: 'https://github.com/test/repo/pull/1.diff',
    base_ref: 'main',
    head_ref: 'feature',
    review_count: 3,
    prompt: 'Review this PR',
    timeout_at: Date.now() + 600_000,
    status: 'pending',
    queue: 'review',
    github_installation_id: 1,
    private: false,
    config: DEFAULT_REVIEW_CONFIG,
    created_at: Date.now(),
    ...overrides,
  };
}

function makeClaim(overrides: Partial<TaskClaim> = {}): TaskClaim {
  return {
    id: 'task-1:agent-1:review',
    task_id: 'task-1',
    agent_id: 'agent-1',
    role: 'review',
    status: 'pending',
    created_at: Date.now(),
    ...overrides,
  };
}

describe('task-lifecycle', () => {
  describe('isTaskActive', () => {
    it('returns true for pending tasks', () => {
      expect(isTaskActive(makeTask({ status: 'pending' }))).toBe(true);
    });

    it('returns true for reviewing tasks', () => {
      expect(isTaskActive(makeTask({ status: 'reviewing' }))).toBe(true);
    });

    it('returns false for completed tasks', () => {
      expect(isTaskActive(makeTask({ status: 'completed' }))).toBe(false);
    });

    it('returns false for timed out tasks', () => {
      expect(isTaskActive(makeTask({ status: 'timeout' }))).toBe(false);
    });

    it('returns false for failed tasks', () => {
      expect(isTaskActive(makeTask({ status: 'failed' }))).toBe(false);
    });
  });

  describe('isTaskTerminal', () => {
    it('returns true when status is completed', () => {
      expect(isTaskTerminal(makeTask({ status: 'completed' }))).toBe(true);
    });

    it('returns true when queue is completed', () => {
      expect(isTaskTerminal(makeTask({ queue: 'completed' }))).toBe(true);
    });

    it('returns false for active tasks', () => {
      expect(isTaskTerminal(makeTask({ status: 'reviewing', queue: 'review' }))).toBe(false);
    });
  });

  describe('queue queries', () => {
    it('isInReviewQueue', () => {
      expect(isInReviewQueue(makeTask({ queue: 'review' }))).toBe(true);
      expect(isInReviewQueue(makeTask({ queue: 'summary' }))).toBe(false);
    });

    it('isInSummaryQueue', () => {
      expect(isInSummaryQueue(makeTask({ queue: 'summary' }))).toBe(true);
      expect(isInSummaryQueue(makeTask({ queue: 'review' }))).toBe(false);
    });

    it('isSummaryClaimed', () => {
      expect(isSummaryClaimed(makeTask({ queue: 'finished' }))).toBe(true);
      expect(isSummaryClaimed(makeTask({ queue: 'summary' }))).toBe(false);
    });
  });

  describe('isTimedOut', () => {
    it('returns true when timeout has passed', () => {
      const now = 1000;
      expect(isTimedOut(makeTask({ timeout_at: 500 }), now)).toBe(true);
    });

    it('returns false when timeout is in the future', () => {
      const now = 1000;
      expect(isTimedOut(makeTask({ timeout_at: 2000 }), now)).toBe(false);
    });

    it('returns true when timeout equals now', () => {
      const now = 1000;
      expect(isTimedOut(makeTask({ timeout_at: 1000 }), now)).toBe(true);
    });
  });

  describe('claim queries', () => {
    it('isClaimPending', () => {
      expect(isClaimPending(makeClaim({ status: 'pending' }))).toBe(true);
      expect(isClaimPending(makeClaim({ status: 'completed' }))).toBe(false);
    });

    it('isClaimTerminal', () => {
      expect(isClaimTerminal(makeClaim({ status: 'completed' }))).toBe(true);
      expect(isClaimTerminal(makeClaim({ status: 'rejected' }))).toBe(true);
      expect(isClaimTerminal(makeClaim({ status: 'error' }))).toBe(true);
      expect(isClaimTerminal(makeClaim({ status: 'pending' }))).toBe(false);
    });

    it('isClaimFailed', () => {
      expect(isClaimFailed(makeClaim({ status: 'rejected' }))).toBe(true);
      expect(isClaimFailed(makeClaim({ status: 'error' }))).toBe(true);
      expect(isClaimFailed(makeClaim({ status: 'completed' }))).toBe(false);
      expect(isClaimFailed(makeClaim({ status: 'pending' }))).toBe(false);
    });
  });

  describe('isCompletedReview', () => {
    it('returns true for completed review claims with text', () => {
      expect(
        isCompletedReview(makeClaim({ role: 'review', status: 'completed', review_text: 'LGTM' })),
      ).toBe(true);
    });

    it('returns false for summary claims', () => {
      expect(
        isCompletedReview(
          makeClaim({ role: 'summary', status: 'completed', review_text: 'Summary' }),
        ),
      ).toBe(false);
    });

    it('returns false for pending review claims', () => {
      expect(isCompletedReview(makeClaim({ role: 'review', status: 'pending' }))).toBe(false);
    });

    it('returns false for completed review claims without text', () => {
      expect(
        isCompletedReview(
          makeClaim({ role: 'review', status: 'completed', review_text: undefined }),
        ),
      ).toBe(false);
    });
  });

  describe('shouldTransitionToSummary', () => {
    it('returns true when all reviews are complete and in review queue', () => {
      expect(shouldTransitionToSummary(2, 2, 'review')).toBe(true);
    });

    it('returns true when more reviews than slots (late arrivals)', () => {
      expect(shouldTransitionToSummary(3, 2, 'review')).toBe(true);
    });

    it('returns false when reviews are not complete', () => {
      expect(shouldTransitionToSummary(1, 2, 'review')).toBe(false);
    });

    it('returns false when already in summary queue', () => {
      expect(shouldTransitionToSummary(2, 2, 'summary')).toBe(false);
    });

    it('returns false when already in finished queue', () => {
      expect(shouldTransitionToSummary(2, 2, 'finished')).toBe(false);
    });

    it('returns false when reviewSlots is 0 (single-review task)', () => {
      expect(shouldTransitionToSummary(0, 0, 'review')).toBe(false);
    });
  });
});
