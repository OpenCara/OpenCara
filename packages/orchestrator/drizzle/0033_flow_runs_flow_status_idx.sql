-- Speed up the kanban implement-status query (OpenCara#146).
--
-- loadImplementStatuses() runs on every kanban board snapshot with:
--   WHERE flow_id = ? AND status IN ('pending','running')
--      OR (status IN ('failed','cancelled') AND created_at > now() - '1 hour')
-- Without a (flow_id, status, created_at) index this falls back to the
-- flow_id FK index and reads every run for the implement flow — and that flow
-- accumulates thousands of cancelled `trigger_skip` rows from webhook fan-out,
-- so each snapshot scanned ~16k rows. Under the project-scoped/coalesced SSE
-- rebuilds (#149) the rate is bounded, but this keeps each rebuild cheap and
-- stops a busy board from pinning a DB pool connection.
CREATE INDEX IF NOT EXISTS "flow_runs_flow_status_created_at_idx"
  ON "flow_runs" USING btree ("flow_id", "status", "created_at" DESC NULLS LAST);
