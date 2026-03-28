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
