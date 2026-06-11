-- Firing bookkeeping for `schedule.cron` trigger nodes (#128). One row per
-- (flow_id, node_id); the scheduler loop initialises next_fire_at to the next
-- cron occurrence and advances it on each fire. ON DELETE CASCADE so removing a
-- schedule flow drops its state. The partial-free btree on next_fire_at serves
-- the scheduler's `WHERE next_fire_at <= now()` tick query.
CREATE TABLE "flow_schedule_state" (
	"id" text PRIMARY KEY NOT NULL,
	"flow_id" text NOT NULL,
	"node_id" text NOT NULL,
	"cron" text NOT NULL,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"next_fire_at" timestamp with time zone,
	"last_fired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flow_schedule_state" ADD CONSTRAINT "flow_schedule_state_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "flow_schedule_state_flow_node_uq" ON "flow_schedule_state" USING btree ("flow_id","node_id");--> statement-breakpoint
CREATE INDEX "flow_schedule_state_next_fire_idx" ON "flow_schedule_state" USING btree ("next_fire_at");
