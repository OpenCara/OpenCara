import { describe, it, expect } from 'vitest';
import {
  evaluateSummaryQuality,
  DEFAULT_SUMMARY_MIN_LENGTH,
  MAX_SUMMARY_RETRIES,
} from '../summary-evaluator.js';

describe('evaluateSummaryQuality', () => {
  const sampleReviews = [
    'The authentication middleware has a vulnerability where session tokens are stored in plain text. Consider using encrypted cookies or JWT tokens instead. The error handling in the login function is insufficient.',
    'Performance issue in the database query on line 42. The N+1 query pattern should be replaced with a JOIN. Also, the connection pooling configuration needs adjustment for production workloads.',
  ];

  // Helper: generate a valid summary that references reviews
  function validSummary(): string {
    return (
      'This pull request has several issues that need addressing. ' +
      'The authentication middleware has a vulnerability related to session tokens stored in plain text — ' +
      'encrypted cookies or JWT tokens would be more appropriate. ' +
      'Additionally, there is a performance issue with the database query that exhibits an N+1 pattern. ' +
      'Replacing it with a JOIN and adjusting connection pooling would significantly improve production workloads. ' +
      'The error handling in the login function also needs improvement.'
    );
  }

  describe('passing summaries', () => {
    it('passes a well-formed summary that references reviews', () => {
      const result = evaluateSummaryQuality(validSummary(), sampleReviews);
      expect(result.pass).toBe(true);
      expect(result.reason).toBeUndefined();
    });

    it('passes with no individual reviews (skip overlap check)', () => {
      const longText = 'x'.repeat(DEFAULT_SUMMARY_MIN_LENGTH + 1);
      const result = evaluateSummaryQuality(longText, []);
      expect(result.pass).toBe(true);
    });

    it('passes with custom minimum length', () => {
      const text = 'This summary references authentication and database query performance issues.';
      const result = evaluateSummaryQuality(text, sampleReviews, 50);
      expect(result.pass).toBe(true);
    });
  });

  describe('blocklist exact matches', () => {
    const blockedPhrases = [
      'LGTM',
      'lgtm',
      'No issues found',
      'No issues found.',
      'Looks good to me',
      'Looks good to me.',
      'Approved',
      'Approved.',
      'No comments',
      'No comments.',
      'Nothing to report',
      'Nothing to report.',
    ];

    for (const phrase of blockedPhrases) {
      it(`rejects exact match: "${phrase}"`, () => {
        const result = evaluateSummaryQuality(phrase, sampleReviews);
        expect(result.pass).toBe(false);
        expect(result.reason).toContain('blocklist');
      });
    }

    it('rejects blocklist matches with leading/trailing whitespace', () => {
      const result = evaluateSummaryQuality('  LGTM  ', sampleReviews);
      expect(result.pass).toBe(false);
    });
  });

  describe('blocklist regex patterns', () => {
    const regexBlocked = [
      'No',
      'None',
      'N/A',
      'OK',
      'Approved',
      'No.',
      'None.',
      'OK ',
      'LGTM!',
      'LGTM.',
      'LGTM  ',
      'Looks good',
      'Looks good!',
      'Look good.',
      'No issues',
      'No issue found',
      'No issues found!',
    ];

    for (const phrase of regexBlocked) {
      it(`rejects regex pattern: "${phrase}"`, () => {
        const result = evaluateSummaryQuality(phrase, sampleReviews);
        expect(result.pass).toBe(false);
        expect(result.reason).toBeDefined();
      });
    }
  });

  describe('minimum length', () => {
    it('rejects summaries shorter than default minimum', () => {
      const shortText = 'This is too short to be a real review synthesis.';
      const result = evaluateSummaryQuality(shortText, sampleReviews);
      expect(result.pass).toBe(false);
      expect(result.reason).toContain('too short');
      expect(result.reason).toContain(String(DEFAULT_SUMMARY_MIN_LENGTH));
    });

    it('rejects summaries shorter than custom minimum', () => {
      const text = 'Short.';
      const result = evaluateSummaryQuality(text, [], 500);
      expect(result.pass).toBe(false);
      expect(result.reason).toContain('too short');
      expect(result.reason).toContain('500');
    });

    it('passes summaries exactly at minimum length with no reviews', () => {
      const text = 'a'.repeat(DEFAULT_SUMMARY_MIN_LENGTH);
      const result = evaluateSummaryQuality(text, []);
      expect(result.pass).toBe(true);
    });
  });

  describe('review reference check', () => {
    it('rejects summaries with no overlap with individual reviews', () => {
      // Long enough but totally unrelated content
      const unrelatedSummary =
        'Lorem ipsum dolor sit amet, consectetur adipiscing elit. ' +
        'Nullam euismod, nisl eget ultricies aliquam, nunc nisl ultricies nunc, ' +
        'vitae ultricies nisl nunc eget nisl. Donec euismod, nisl eget ultricies ' +
        'aliquam, nunc nisl ultricies nunc, vitae ultricies nisl nunc eget nisl.';
      const result = evaluateSummaryQuality(unrelatedSummary, sampleReviews);
      expect(result.pass).toBe(false);
      expect(result.reason).toContain('does not reference individual reviews');
    });

    it('passes summaries with sufficient overlap', () => {
      const result = evaluateSummaryQuality(validSummary(), sampleReviews);
      expect(result.pass).toBe(true);
    });

    it('skips overlap check when no individual reviews exist', () => {
      const text = 'a'.repeat(DEFAULT_SUMMARY_MIN_LENGTH);
      const result = evaluateSummaryQuality(text, []);
      expect(result.pass).toBe(true);
    });
  });

  describe('constants', () => {
    it('DEFAULT_SUMMARY_MIN_LENGTH is 200', () => {
      expect(DEFAULT_SUMMARY_MIN_LENGTH).toBe(200);
    });

    it('MAX_SUMMARY_RETRIES is 3', () => {
      expect(MAX_SUMMARY_RETRIES).toBe(3);
    });
  });
});
