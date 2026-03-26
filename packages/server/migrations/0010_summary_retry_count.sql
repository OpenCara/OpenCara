-- Add summary_retry_count to tasks for tracking failed summary quality evaluations.
ALTER TABLE tasks ADD COLUMN summary_retry_count INTEGER NOT NULL DEFAULT 0;
