-- Drop the old unique index that only allows 1 active task per PR.
-- The M19 multi-task group model creates multiple active tasks per PR
-- (one per agent slot), so this constraint must be removed.
-- Application-layer dedup in createTaskIfNotExists (INSERT...WHERE NOT EXISTS)
-- still prevents duplicate webhook-triggered groups.
DROP INDEX IF EXISTS idx_tasks_active_pr;
