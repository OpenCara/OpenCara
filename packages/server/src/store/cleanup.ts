import type { Logger } from '../logger.js';
import type { DataStore } from './interface.js';
import { RELIABILITY_WINDOW_MS, REPUTATION_PRUNE_AFTER_MS } from './constants.js';

/**
 * Runs the event-table prune sequence invoked by both the Cloudflare Workers
 * `scheduled` handler and the Node self-hosted cron loop. Keeps runtime parity
 * so `agent_reliability_events` and `reputation_events` are bounded on every
 * supported deployment.
 *
 * - Reliability events are pruned every tick with a 2× window cutoff (60 min).
 *   Dispatch reads only the last `RELIABILITY_WINDOW_MS`, so anything older is
 *   guaranteed unread.
 * - Reputation events are pruned only when the tick lands on minute 0 (hourly)
 *   with a 180-day cutoff. Exponential decay (14-day half-life) makes per-event
 *   weight at 180 days ≈ 0.00014, so deletion is effectively lossless.
 *
 * Each cleanup swallows its error so one failing prune never blocks the other,
 * and only emits an info log when rows were actually deleted.
 */
export async function runScheduledEventPrunes(
  store: DataStore,
  scheduledTime: number,
  logger: Logger,
): Promise<void> {
  try {
    const cutoff = Date.now() - RELIABILITY_WINDOW_MS * 2;
    const deleted = await store.cleanupStaleReliabilityEvents(cutoff);
    if (deleted > 0) {
      logger.info('Cleaned up stale reliability events', {
        action: 'cleanup_reliability',
        deleted,
      });
    }
  } catch (err) {
    logger.error('Scheduled reliability event cleanup failed', {
      action: 'cleanup_reliability',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // Use UTC so cadence matches across runtimes regardless of the host
  // machine's local timezone (CF Workers runs in UTC; self-hosted Node may not).
  if (new Date(scheduledTime).getUTCMinutes() === 0) {
    try {
      const cutoff = Date.now() - REPUTATION_PRUNE_AFTER_MS;
      const deleted = await store.cleanupStaleReputationEvents(cutoff);
      if (deleted > 0) {
        logger.info('Cleaned up stale reputation events', {
          action: 'cleanup_reputation',
          deleted,
        });
      }
    } catch (err) {
      logger.error('Scheduled reputation event cleanup failed', {
        action: 'cleanup_reputation',
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
