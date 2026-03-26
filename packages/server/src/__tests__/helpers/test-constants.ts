/**
 * Shared test constants for summary quality gate compliance.
 *
 * The quality evaluator requires summaries to be >= 200 chars and not match
 * low-effort patterns. These constants provide valid text for tests that need
 * to submit summaries but aren't specifically testing the quality gate.
 */

/**
 * A valid summary text that passes the quality gate for single-agent tasks
 * (review_count=1, no individual reviews to cross-reference).
 */
export const VALID_SUMMARY_TEXT =
  'This pull request introduces several important changes to the codebase. ' +
  'The implementation follows established patterns and conventions. ' +
  'Error handling has been improved throughout the modified code paths. ' +
  'Overall the changes are well-structured and ready for production deployment.';

/**
 * A valid summary text that passes the quality gate for multi-agent tasks
 * where individual review texts mention authentication, database, and performance.
 */
export const VALID_MULTI_REVIEW_SUMMARY =
  'This pull request has several issues that need addressing. ' +
  'The authentication middleware has a vulnerability related to session tokens stored in plain text. ' +
  'Additionally, there is a performance issue with the database query that exhibits an N+1 pattern. ' +
  'Replacing it with a JOIN would significantly improve performance. ' +
  'Overall, security and performance improvements are needed before merging.';
