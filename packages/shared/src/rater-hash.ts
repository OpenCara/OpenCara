/**
 * Compute a privacy-preserving hash for rating dedup.
 * Uses SHA-256 of `review_result_id || github_id` — same algorithm as the DB migration.
 * Works in both Node.js and Cloudflare Workers (Web Crypto API).
 */
export async function computeRaterHash(reviewResultId: string, githubId: number): Promise<string> {
  const input = `${reviewResultId}${githubId}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
