-- Split 'dedup' and 'triage' task_type values into pr/issue variants.
-- The role now encodes the target, making dedup_target redundant.

-- Convert existing dedup tasks based on dedup_target column
UPDATE tasks SET task_type = 'pr_dedup' WHERE task_type = 'dedup' AND dedup_target = 'pr';
UPDATE tasks SET task_type = 'issue_dedup' WHERE task_type = 'dedup' AND dedup_target = 'issue';

-- Convert any remaining 'dedup' tasks (fallback to pr_dedup)
UPDATE tasks SET task_type = 'pr_dedup' WHERE task_type = 'dedup';

-- Convert triage tasks (all triage is issue_triage currently)
UPDATE tasks SET task_type = 'issue_triage' WHERE task_type = 'triage';
