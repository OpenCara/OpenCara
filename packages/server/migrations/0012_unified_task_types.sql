-- Add unified task type fields for multi-agent pipeline (M19)
ALTER TABLE tasks ADD COLUMN task_type TEXT NOT NULL DEFAULT 'review';
ALTER TABLE tasks ADD COLUMN feature TEXT NOT NULL DEFAULT 'review';
ALTER TABLE tasks ADD COLUMN group_id TEXT NOT NULL DEFAULT '';

-- Issue fields (for dedup/triage on issues)
ALTER TABLE tasks ADD COLUMN issue_number INTEGER;
ALTER TABLE tasks ADD COLUMN issue_url TEXT;
ALTER TABLE tasks ADD COLUMN issue_title TEXT;
ALTER TABLE tasks ADD COLUMN issue_body TEXT;
ALTER TABLE tasks ADD COLUMN issue_author TEXT;

-- Dedup fields
ALTER TABLE tasks ADD COLUMN dedup_target TEXT;
ALTER TABLE tasks ADD COLUMN index_issue_number INTEGER;

-- Backfill group_id for existing tasks (use task id as group)
UPDATE tasks SET group_id = id WHERE group_id = '';
