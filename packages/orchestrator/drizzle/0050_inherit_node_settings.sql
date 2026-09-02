-- Project flows now INHERIT the account-scope template's node settings by
-- default; a flow_node_settings row exists only as a per-project override.
-- Until now every project got a verbatim copy of the template rows when it
-- was seeded, so drop the copies that still match their template row
-- exactly — those projects were never really overriding anything. Rows that
-- differ (a different agent, pool, prompt or label) are genuine overrides and
-- stay.
DELETE FROM "flow_node_settings" s
USING "flows" f, "projects" p, "template_node_settings" t
WHERE f."id" = s."flow_id"
  AND p."id" = f."project_id"
  AND t."user_id" = p."added_by_user_id"
  AND t."template_slug" = f."slug"
  AND t."node_id" = s."node_id"
  AND s."prompt_id" IS NOT DISTINCT FROM t."prompt_id"
  AND s."agent_id" IS NOT DISTINCT FROM t."agent_id"
  AND s."fallback_agent_ids" = t."fallback_agent_ids"
  AND s."retry_same" = t."retry_same"
  AND s."concurrency" = t."concurrency"
  AND s."quorum" = t."quorum"
  AND s."label" IS NOT DISTINCT FROM t."label";
--> statement-breakpoint
-- Leftover sibling-reviewer rows (`reviewer_correctness`, `reviewer_<rand>`)
-- from before the reviewer pool are inert once the graph carries the pool
-- `reviewer` node, but the boot-time fold would rebuild a project override
-- from them if the project's own reviewer row was just dropped above. Remove
-- them wherever the pool node is already in the graph; graphs still on the
-- old shape keep theirs for the fold.
DELETE FROM "flow_node_settings" s
USING "flows" f
WHERE f."id" = s."flow_id"
  AND s."node_id" LIKE 'reviewer\_%'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(f."graph_json"->'nodes') n WHERE n->>'id' = 'reviewer')
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(f."graph_json"->'nodes') n WHERE n->>'id' = s."node_id");--> statement-breakpoint
DELETE FROM "template_node_settings" t
USING "template_drafts" d
WHERE d."user_id" = t."user_id" AND d."template_slug" = t."template_slug"
  AND t."node_id" LIKE 'reviewer\_%'
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(d."graph_json"->'nodes') n WHERE n->>'id' = 'reviewer')
  AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(d."graph_json"->'nodes') n WHERE n->>'id' = t."node_id");
