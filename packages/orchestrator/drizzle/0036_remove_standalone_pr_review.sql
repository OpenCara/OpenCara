-- Remove the standalone `pr-review` built-in.
--
-- Migration 0035's predecessor briefly seeded `pr-review` (single reviewer)
-- into every project as a disabled-by-default opt-in. That's now superseded:
-- single vs. multi review is handled INSIDE the development-lifecycle review
-- stage (add/remove reviewer nodes), so the standalone flow is redundant.
-- `pr-review` has moved back to legacyBuiltinFlows (no longer seeded).
--
-- Delete only pr-review rows that have NO flow_runs — i.e. the empty,
-- disabled rows just seeded. The FK flow_runs.flow_id → flows.id is
-- ON DELETE CASCADE, so scoping to run-less rows avoids destroying the run
-- history of any project that genuinely used pr-review in the past (those
-- rows stay, still disabled from migration 0032). Fresh databases have no
-- pr-review rows, so this is a no-op there.

DELETE FROM "flows"
WHERE slug = 'pr-review'
  AND id NOT IN (SELECT DISTINCT flow_id FROM "flow_runs");
