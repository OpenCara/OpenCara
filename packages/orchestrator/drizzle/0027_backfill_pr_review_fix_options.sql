-- PR #78 (closes #71) added `autoMerge` and `maxIterations` config blocks
-- to the `pr-review-fix` built-in agent node, but `flows` /
-- `template_drafts` rows whose graph_json was instantiated BEFORE that PR
-- still carry the old shape. The flow editor's AgentAutoMergeSection /
-- AgentMaxIterationsSection gate on the block being present, so the
-- controls were invisible on every pr-review-fix flow created before the
-- feature shipped.
--
-- Backfill the two blocks onto the agent node of every pr-review-fix row
-- that's missing them. Defaults mirror packages/flows/src/builtin/pr-review-fix.ts.
-- Idempotent: rows that already have the key are skipped via the WHERE
-- clause; jsonb_set's create_missing flag won't replace existing values.

-- ─── flows ───────────────────────────────────────────────────────────
WITH targets AS (
  SELECT
    f.id AS flow_id,
    (n.idx - 1)::text AS node_idx_str,
    n.node->'config' AS node_config
  FROM "flows" f
  CROSS JOIN LATERAL jsonb_array_elements(f.graph_json->'nodes')
    WITH ORDINALITY AS n(node, idx)
  WHERE f.slug = 'pr-review-fix'
    AND n.node->>'kind' = 'agent'
)
UPDATE "flows" f
SET graph_json = jsonb_set(
      f.graph_json,
      ARRAY['nodes', t.node_idx_str, 'config', 'autoMerge'],
      '{"enabled": false, "method": "squash", "requireChecks": true, "requireApproval": false, "mergeWithoutChanges": false}'::jsonb,
      true
    ),
    updated_at = now()
FROM targets t
WHERE f.id = t.flow_id
  AND NOT (t.node_config ? 'autoMerge');

WITH targets AS (
  SELECT
    f.id AS flow_id,
    (n.idx - 1)::text AS node_idx_str,
    n.node->'config' AS node_config
  FROM "flows" f
  CROSS JOIN LATERAL jsonb_array_elements(f.graph_json->'nodes')
    WITH ORDINALITY AS n(node, idx)
  WHERE f.slug = 'pr-review-fix'
    AND n.node->>'kind' = 'agent'
)
UPDATE "flows" f
SET graph_json = jsonb_set(
      f.graph_json,
      ARRAY['nodes', t.node_idx_str, 'config', 'maxIterations'],
      '{"enabled": false, "limit": null, "commentOnSkip": false}'::jsonb,
      true
    ),
    updated_at = now()
FROM targets t
WHERE f.id = t.flow_id
  AND NOT (t.node_config ? 'maxIterations');

-- ─── template_drafts ─────────────────────────────────────────────────
WITH targets AS (
  SELECT
    d.id AS draft_id,
    (n.idx - 1)::text AS node_idx_str,
    n.node->'config' AS node_config
  FROM "template_drafts" d
  CROSS JOIN LATERAL jsonb_array_elements(d.graph_json->'nodes')
    WITH ORDINALITY AS n(node, idx)
  WHERE d.template_slug = 'pr-review-fix'
    AND n.node->>'kind' = 'agent'
)
UPDATE "template_drafts" d
SET graph_json = jsonb_set(
      d.graph_json,
      ARRAY['nodes', t.node_idx_str, 'config', 'autoMerge'],
      '{"enabled": false, "method": "squash", "requireChecks": true, "requireApproval": false, "mergeWithoutChanges": false}'::jsonb,
      true
    ),
    updated_at = now()
FROM targets t
WHERE d.id = t.draft_id
  AND NOT (t.node_config ? 'autoMerge');

WITH targets AS (
  SELECT
    d.id AS draft_id,
    (n.idx - 1)::text AS node_idx_str,
    n.node->'config' AS node_config
  FROM "template_drafts" d
  CROSS JOIN LATERAL jsonb_array_elements(d.graph_json->'nodes')
    WITH ORDINALITY AS n(node, idx)
  WHERE d.template_slug = 'pr-review-fix'
    AND n.node->>'kind' = 'agent'
)
UPDATE "template_drafts" d
SET graph_json = jsonb_set(
      d.graph_json,
      ARRAY['nodes', t.node_idx_str, 'config', 'maxIterations'],
      '{"enabled": false, "limit": null, "commentOnSkip": false}'::jsonb,
      true
    ),
    updated_at = now()
FROM targets t
WHERE d.id = t.draft_id
  AND NOT (t.node_config ? 'maxIterations');
