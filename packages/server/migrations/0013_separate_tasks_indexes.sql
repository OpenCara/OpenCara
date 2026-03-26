-- Add indexes for separate task model (group_id lookups, active issue dedup)
CREATE INDEX IF NOT EXISTS idx_tasks_group ON tasks(group_id) WHERE group_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_active_issue
  ON tasks(owner, repo, issue_number, task_type)
  WHERE status IN ('pending', 'reviewing') AND issue_number IS NOT NULL;
