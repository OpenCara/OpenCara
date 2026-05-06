-- The Flow runs page on a project surfaces every flow_run, including the
-- ones the engine cancels at the trigger node because the inbound webhook
-- doesn't match (wrong event type, action not in trigger filter, etc.).
-- Each webhook fans out to (project flow × event), so a single
-- pull_request webhook that doesn't match a given flow's trigger
-- generates a visible noisy-cancel row per flow.
--
-- This column lets the API distinguish *why* a run was cancelled:
--
--   'trigger_skip' — engine skipped at the trigger node. Hidden from
--     the Flow runs page by default; surfaced via ?includeSkipped=true
--     for debugging.
--   'abandoned' — reaper picked up a run still in pending/running at
--     restart. Surfaced normally; these represent real lost work.
--
-- Existing rows keep cancel_reason NULL — backfilling would be a
-- best-effort string match against `error` and isn't worth the surgery.
-- New cancellations always set the column.

ALTER TABLE "flow_runs"
  ADD COLUMN "cancel_reason" text;
