import { describe, it, expect } from 'vitest';
import { verdictToReviewEvent } from '../github/reviews.js';
import type { ReviewVerdict } from '@opencara/shared';

describe('verdictToReviewEvent', () => {
  it('maps lowercase verdicts correctly', () => {
    expect(verdictToReviewEvent('approve')).toBe('APPROVE');
    expect(verdictToReviewEvent('request_changes')).toBe('REQUEST_CHANGES');
    expect(verdictToReviewEvent('comment')).toBe('COMMENT');
  });

  it('handles uppercase verdicts (case-insensitive)', () => {
    expect(verdictToReviewEvent('APPROVE' as ReviewVerdict)).toBe('APPROVE');
    expect(verdictToReviewEvent('REQUEST_CHANGES' as ReviewVerdict)).toBe('REQUEST_CHANGES');
    expect(verdictToReviewEvent('COMMENT' as ReviewVerdict)).toBe('COMMENT');
  });

  it('handles mixed-case verdicts', () => {
    expect(verdictToReviewEvent('Approve' as ReviewVerdict)).toBe('APPROVE');
    expect(verdictToReviewEvent('Request_Changes' as ReviewVerdict)).toBe('REQUEST_CHANGES');
    expect(verdictToReviewEvent('Comment' as ReviewVerdict)).toBe('COMMENT');
  });
});
