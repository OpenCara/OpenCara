-- Rename the unified `issue-lifecycle` flow to `development-lifecycle`.
--
-- The old slug named only the entry point (an issue moving to Ready), but the
-- flow now spans the whole development cycle: issue → implement → PR → fan-out
-- review → fix → auto-merge. The code template's slug changes in lockstep
-- (packages/flows builtinFlows), so without this rename the seeder would treat
-- `development-lifecycle` as a brand-new builtin and INSERT a second row into
-- every project — double-dispatching alongside the still-enabled
-- `issue-lifecycle` row (the exact failure mode migration 0032 fixed for the
-- legacy flows).
--
-- Renaming in place preserves everything keyed off the flow row: per-project
-- graph customizations (`flows.customized_at` + `graph_json`), enabled state,
-- and `flow_node_settings` (keyed by flow_id, untouched). The two template
-- tables key off the slug, so they move too, keeping owners' template-page
-- edits attached. Historical `pm_waves.flow_slug` rows are an append-only log
-- and are intentionally left as-is.
--
-- Fresh databases have no flows at migration time, so all three UPDATEs are
-- no-ops there; new projects simply seed `development-lifecycle` directly.

UPDATE "flows"
SET slug = 'development-lifecycle',
    updated_at = now()
WHERE slug = 'issue-lifecycle';
--> statement-breakpoint
UPDATE "template_drafts"
SET template_slug = 'development-lifecycle'
WHERE template_slug = 'issue-lifecycle';
--> statement-breakpoint
UPDATE "template_node_settings"
SET template_slug = 'development-lifecycle'
WHERE template_slug = 'issue-lifecycle';
