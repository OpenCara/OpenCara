-- Per-claim liveness timestamp. Updated by POST /api/tasks/:taskId/heartbeat
-- while a long-running tool is executing so reclaimAbandonedClaims does not
-- mark the claim as 'error' mid-run when the agent-level heartbeat is only
-- refreshed at claim-create / result-submit. Nullable: NULL on claims created
-- before this migration, in which case reclaim falls back to the agent-level
-- heartbeat (back-compat with old CLIs).
ALTER TABLE claims ADD COLUMN last_heartbeat_at INTEGER;
