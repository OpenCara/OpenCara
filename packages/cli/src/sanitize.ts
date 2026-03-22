/**
 * Centralized token sanitization for all CLI output.
 *
 * Strips GitHub tokens and other secrets from strings before they are
 * logged, submitted to the server, or displayed to the user.
 */

/** GitHub token patterns: ghp_, gho_, ghs_, ghr_, github_pat_ */
const GITHUB_TOKEN_PATTERN =
  /\b(ghp_[A-Za-z0-9_]{1,255}|gho_[A-Za-z0-9_]{1,255}|ghs_[A-Za-z0-9_]{1,255}|ghr_[A-Za-z0-9_]{1,255}|github_pat_[A-Za-z0-9_]{1,255})\b/g;

/** x-access-token embedded in URLs (used for git clone) */
const EMBEDDED_TOKEN_PATTERN = /x-access-token:[^@\s]+@/g;

/** Authorization header values in URLs or error messages */
const AUTH_HEADER_PATTERN = /(Authorization:)\s*(?:token|Bearer)\s+[^\s,;'"]+/gi;

/**
 * Remove known token patterns from a string.
 * Safe to call on any string — returns the input unchanged if no tokens found.
 */
export function sanitizeTokens(input: string): string {
  return input
    .replace(GITHUB_TOKEN_PATTERN, '***')
    .replace(EMBEDDED_TOKEN_PATTERN, 'x-access-token:***@')
    .replace(AUTH_HEADER_PATTERN, '$1 ***');
}
