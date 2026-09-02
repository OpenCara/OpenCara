-- Index for the Activity feed's per-event "triggered flow runs" lookup
-- (WHERE trigger_event_id IN (...)). The FK to platform_events creates no
-- index on its own, and flow_runs accumulates thousands of trigger_skip rows
-- (OpenCara#146), so the lookup seq-scanned the table on every page load.
CREATE INDEX IF NOT EXISTS "flow_runs_trigger_event_id_idx" ON "flow_runs" ("trigger_event_id");
