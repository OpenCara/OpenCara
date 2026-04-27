ALTER TABLE "agent_hosts" ADD COLUMN "system_info" jsonb;--> statement-breakpoint
ALTER TABLE "agent_hosts" ADD COLUMN "system_info_updated_at" timestamp with time zone;