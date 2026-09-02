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
