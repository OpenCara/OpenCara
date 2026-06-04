-- Issue #124: the four stage-specific built-in flows (`issue-implement`,
-- `pr-review`, `pr-review-multi`, `pr-review-fix`) are superseded by the
-- single `issue-lifecycle` flow, which merges them into one graph with
-- three trigger entry-points. The orchestrator now seeds ONLY
-- `issue-lifecycle` (packages/flows builtinFlows), so on the next boot
-- every existing project gets the unified flow inserted.
--
-- Left untouched, the legacy rows would keep firing alongside the unified
-- flow — e.g. a single `pull_request.opened` would post a review from
-- `pr-review`, another from `pr-review-multi`, AND another from the unified
-- flow's review stage. Disable the legacy rows once so the unified flow is
-- the only thing dispatching. This is a ONE-TIME convergence: re-enabling a
-- legacy flow afterwards (an operator deliberately opting back into the old
-- behaviour) sticks, because the migration never runs again.
--
-- Customised legacy graphs are preserved on disk (only `enabled` flips), so
-- nothing is lost and the change is reversible from the flow detail page.
-- Fresh databases have no flows yet at migration time, so this is a no-op
-- there; new projects simply never get the legacy rows seeded.

UPDATE "flows"
SET enabled = false,
    updated_at = now()
WHERE slug IN ('issue-implement', 'pr-review', 'pr-review-multi', 'pr-review-fix')
  AND enabled = true;
