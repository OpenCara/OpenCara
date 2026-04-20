/** Default TTL for terminal task entries: 7 days */
export const DEFAULT_TTL_DAYS = 7;

/** Agent heartbeat stale threshold for claim expiry: 10 minutes */
export const CLAIM_STALE_THRESHOLD_MS = 10 * 60 * 1000;

/** Summary slot stale threshold: 5 minutes */
export const SUMMARY_SLOT_STALE_THRESHOLD_MS = 5 * 60 * 1000;

/** Maximum number of review_text rejections before an agent is blocked. */
export const AGENT_REJECTION_THRESHOLD = 5;

/** Time window for rejection counting: 24 hours. */
export const AGENT_REJECTION_WINDOW_MS = 24 * 60 * 60 * 1000;

// ── Reputation system constants ──────────────────────────────────

/** Bayesian prior alpha (pseudo-upvotes for cold start). */
export const REPUTATION_PRIOR_UP = 2;

/** Bayesian prior beta (pseudo-downvotes for cold start). */
export const REPUTATION_PRIOR_DOWN = 2;

/** Exponential decay half-life for reputation events: 14 days. */
export const REPUTATION_DECAY_HALF_LIFE_MS = 14 * 24 * 60 * 60 * 1000;

/** Wilson score threshold for "proven good" agents (priority boost). */
export const REPUTATION_GOOD_THRESHOLD = 0.7;

/** Wilson score threshold below which agents get penalty multiplier. */
export const REPUTATION_NEUTRAL_THRESHOLD = 0.4;

/** Time window for reputation event queries: 90 days. */
export const REPUTATION_SCORE_WINDOW_MS = 90 * 24 * 60 * 60 * 1000;

/** Cooldown: fully cooled down after 10 minutes. */
export const COOLDOWN_FULL_MS = 10 * 60_000;

/** Cooldown: half-cooled threshold at 5 minutes. */
export const COOLDOWN_HALF_MS = 5 * 60_000;

// ── Reliability system constants ─────────────────────────────────

/**
 * Rolling window for per-agent success/error events used in dispatch weighting.
 * 30 minutes: short enough that a recovering agent comes back into rotation
 * naturally as its old failures age out; long enough to smooth over transient
 * hiccups.
 */
export const RELIABILITY_WINDOW_MS = 30 * 60_000;
