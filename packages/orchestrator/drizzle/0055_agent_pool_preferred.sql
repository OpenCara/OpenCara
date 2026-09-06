-- Agent pools grow a third knob: `preferred`, the number of successes the
-- pool aims for, split out of `concurrency` (which until now was both the
-- parallel slot count AND the target). `quorum` stays the floor the node
-- delivers on, and is capped to `preferred` instead of to the slot count.
--
-- NULL = "follow concurrency", i.e. exactly the shape every existing pool
-- already runs with, so this migration changes no behaviour on its own.
-- Reviewer pools can now say parallel 3 / preferred 3 / minimum 2: three
-- reviewers run at once and the run still delivers when one of them fails.
ALTER TABLE "flow_node_settings" ADD COLUMN IF NOT EXISTS "preferred" integer;--> statement-breakpoint
ALTER TABLE "template_node_settings" ADD COLUMN IF NOT EXISTS "preferred" integer;
