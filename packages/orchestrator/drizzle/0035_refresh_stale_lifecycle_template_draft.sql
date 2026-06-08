-- Drop stale pre-multi-review template drafts for `development-lifecycle`.
--
-- The seeder (ensureBuiltinFlowsForProject → resolveSeedGraph) prefers an
-- owner's `template_drafts` row over the code template. A draft that predates
-- the multi-agent review fan-out therefore SHADOWS the new built-in: every
-- project owned by that user keeps re-seeding the old single-reviewer graph,
-- even though customized_at is false. (Migration 0034 carried these drafts
-- forward under the renamed slug, but the shadowing is inherent to the
-- template-draft override — not specific to the rename.)
--
-- Delete only drafts that DON'T already contain the fan-out (the
-- `reviewer_correctness` node), i.e. stale snapshots of the old default. A
-- user who has genuinely adopted/edited the multi-review graph keeps their
-- draft untouched. The owner's real per-node settings (e.g. the implement
-- agent) live in `template_node_settings`, keyed independently of the draft,
-- so they survive this delete.
--
-- With the stale draft gone, the boot-time seed (seedBuiltinFlowsForAllProjects
-- runs after migrate()) refreshes every non-customized project flow from the
-- code template — the multi-review graph. Fresh databases have no drafts, so
-- this is a no-op there.

DELETE FROM "template_drafts"
WHERE template_slug = 'development-lifecycle'
  AND NOT (graph_json -> 'nodes') @> '[{"id":"reviewer_correctness"}]'::jsonb;
