-- Fully purge the standalone `pr-review` flow from every project.
--
-- Migration 0036 removed only run-less pr-review rows, sparing those with
-- historical flow_runs. Per follow-up decision, remove the remaining rows too —
-- pr-review is superseded by single-review-inside-development-lifecycle and
-- should no longer appear (even disabled) in any project's flow list.
--
-- This is intentionally destructive: flow_runs.flow_id → flows.id is
-- ON DELETE CASCADE, and flow_run_steps.flow_run_id → flow_runs.id cascades in
-- turn, so deleting these flow rows also deletes their historical runs and
-- steps. That history loss is accepted. Fresh databases have no pr-review rows,
-- so this is a no-op there.

DELETE FROM "flows" WHERE slug = 'pr-review';
