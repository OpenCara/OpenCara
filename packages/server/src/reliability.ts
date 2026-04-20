/**
 * Per-agent reliability score, derived from recent success/error outcomes.
 *
 * Used as a multiplier (alongside the reputation Wilson score) in the
 * weighted-random agent shuffle during batch-poll dispatch. An agent that
 * has been failing recently gets a lower shuffle score and is less likely
 * to be assigned new tasks. Because events age out of the
 * RELIABILITY_WINDOW_MS window, a broken agent recovers naturally — no
 * explicit backoff is needed.
 */

export interface ReliabilityEvent {
  outcome: 'success' | 'error';
  created_at: string;
}

/**
 * Compute an agent's reliability from recent outcome events.
 *
 * - No history → `1.0` (trust by default — avoids cold-start penalty).
 * - Otherwise → `successes / total` in `[0, 1]`.
 *
 * No floor: an agent with every recent event failing scores `0` and will
 * not be picked by the weighted shuffle. Aging-out of events (queries
 * filter by `RELIABILITY_WINDOW_MS`) restores the score to `1.0` once the
 * last failure falls outside the window.
 */
export function computeReliability(events: readonly ReliabilityEvent[]): number {
  if (events.length === 0) return 1.0;
  let successes = 0;
  for (const e of events) {
    if (e.outcome === 'success') successes++;
  }
  return successes / events.length;
}
