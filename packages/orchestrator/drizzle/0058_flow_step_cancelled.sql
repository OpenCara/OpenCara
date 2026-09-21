-- A pool attempt that was dispatched and then aborted at quorum is
-- 'cancelled', not 'skipped' — 'skipped' means the step never ran.
ALTER TYPE "flow_step_status" ADD VALUE IF NOT EXISTS 'cancelled';
