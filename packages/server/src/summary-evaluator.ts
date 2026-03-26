/**
 * Summary quality evaluator — heuristic checks to reject low-effort synthesis.
 *
 * Runs server-side before posting a summary review to GitHub. No AI calls —
 * only string length, pattern matching, and basic overlap with input reviews.
 */

/** Result of evaluating a summary's quality. */
export interface SummaryEvaluation {
  pass: boolean;
  reason?: string;
}

/** Default minimum character length for a meaningful summary. */
export const DEFAULT_SUMMARY_MIN_LENGTH = 200;

/** Maximum number of summary retries before falling back to timeout-style post. */
export const MAX_SUMMARY_RETRIES = 3;

/**
 * Exact-match low-effort patterns (case-insensitive, tested after trimming).
 * These are complete summaries that provide zero synthesis value.
 */
const BLOCKLIST_EXACT: string[] = [
  'lgtm',
  'no issues found',
  'no issues found.',
  'looks good to me',
  'looks good to me.',
  'approved',
  'approved.',
  'no comments',
  'no comments.',
  'nothing to report',
  'nothing to report.',
];

/**
 * Regex patterns for summaries that are effectively empty.
 * Tested against the full trimmed text (case-insensitive).
 */
const BLOCKLIST_PATTERNS: RegExp[] = [
  /^(no|none|n\/a|ok|approved)[.\s]*$/i,
  /^lgtm[.!\s]*$/i,
  /^looks?\s+good[.!\s]*$/i,
  /^no\s+issues?\s*(found)?[.!\s]*$/i,
];

/**
 * Extract significant words from text (>= 4 chars, lowercased, deduplicated).
 * Filters out very common English words that would produce false positive overlaps.
 */
const STOP_WORDS = new Set([
  'this',
  'that',
  'with',
  'from',
  'have',
  'been',
  'were',
  'will',
  'would',
  'could',
  'should',
  'does',
  'some',
  'they',
  'their',
  'them',
  'these',
  'those',
  'what',
  'when',
  'which',
  'where',
  'about',
  'into',
  'more',
  'also',
  'very',
  'just',
  'than',
  'then',
  'only',
  'each',
  'other',
  'such',
  'most',
  'make',
  'like',
  'over',
  'many',
  'much',
  'both',
  'well',
  'back',
  'even',
  'good',
  'give',
  'code',
  'file',
  'line',
  'change',
  'changes',
  'review',
  'pull',
  'request',
]);

function extractSignificantWords(text: string): Set<string> {
  const words = text.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  return new Set(words.filter((w) => !STOP_WORDS.has(w)));
}

/**
 * Evaluate whether a summary report meets minimum quality thresholds.
 *
 * @param summaryText - The summary report text to evaluate.
 * @param individualReviews - The review_text values from completed review claims.
 * @param minLength - Minimum character length (default: 200).
 * @returns Evaluation result with pass/fail and reason.
 */
export function evaluateSummaryQuality(
  summaryText: string,
  individualReviews: string[],
  minLength: number = DEFAULT_SUMMARY_MIN_LENGTH,
): SummaryEvaluation {
  const trimmed = summaryText.trim();

  // Check 1: blocklist exact matches
  const lower = trimmed.toLowerCase();
  if (BLOCKLIST_EXACT.includes(lower)) {
    return { pass: false, reason: `Matches blocklist pattern: "${trimmed}"` };
  }

  // Check 2: blocklist regex patterns
  for (const pattern of BLOCKLIST_PATTERNS) {
    if (pattern.test(trimmed)) {
      return { pass: false, reason: `Matches rejection pattern: ${pattern.source}` };
    }
  }

  // Check 3: minimum meaningful length
  if (trimmed.length < minLength) {
    return {
      pass: false,
      reason: `Summary too short (${trimmed.length} chars, minimum ${minLength})`,
    };
  }

  // Check 4: must reference individual review content (only when reviews exist)
  if (individualReviews.length > 0) {
    const reviewWords = new Set<string>();
    for (const review of individualReviews) {
      for (const word of extractSignificantWords(review)) {
        reviewWords.add(word);
      }
    }

    const summaryWords = extractSignificantWords(trimmed);
    let overlap = 0;
    for (const word of summaryWords) {
      if (reviewWords.has(word)) overlap++;
    }

    // Require at least 3 overlapping significant words with the input reviews.
    // This is a very low bar — a real synthesis will easily exceed it.
    const MIN_OVERLAP = 3;
    if (overlap < MIN_OVERLAP) {
      return {
        pass: false,
        reason: `Summary does not reference individual reviews (${overlap} overlapping terms, minimum ${MIN_OVERLAP})`,
      };
    }
  }

  return { pass: true };
}
