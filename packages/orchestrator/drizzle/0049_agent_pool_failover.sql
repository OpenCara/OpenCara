-- Agent pool.
--
-- A flow/template agent node keeps `agent_id` as the PRIMARY candidate and
-- gains an ordered list of fallback agent ids plus a policy: per-agent retry
-- count, parallel slots (`concurrency`, also the target number of successes)
-- and the minimum successes (`quorum`). Resolution order at run time:
-- label-routed agent / project default (as before) → agent_id →
-- fallback_agent_ids[]. Each attempt gets its own flow_run_steps row;
-- `attempt` orders them within a node.
ALTER TABLE "flow_node_settings" ADD COLUMN IF NOT EXISTS "fallback_agent_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "flow_node_settings" ADD COLUMN IF NOT EXISTS "retry_same" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "flow_node_settings" ADD COLUMN IF NOT EXISTS "concurrency" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "flow_node_settings" ADD COLUMN IF NOT EXISTS "quorum" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "template_node_settings" ADD COLUMN IF NOT EXISTS "fallback_agent_ids" jsonb NOT NULL DEFAULT '[]'::jsonb;--> statement-breakpoint
ALTER TABLE "template_node_settings" ADD COLUMN IF NOT EXISTS "retry_same" integer NOT NULL DEFAULT 0;--> statement-breakpoint
ALTER TABLE "template_node_settings" ADD COLUMN IF NOT EXISTS "concurrency" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "template_node_settings" ADD COLUMN IF NOT EXISTS "quorum" integer NOT NULL DEFAULT 1;--> statement-breakpoint
ALTER TABLE "flow_run_steps" ADD COLUMN IF NOT EXISTS "attempt" integer NOT NULL DEFAULT 0;
