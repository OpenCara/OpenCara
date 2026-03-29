-- Add diff_size column to tasks table.
-- Stores the total diff size in lines (additions + deletions) from the GitHub webhook payload.
-- NULL for tasks created before this migration or issue-only tasks with no diff.
ALTER TABLE tasks ADD COLUMN diff_size INTEGER DEFAULT NULL;
