CREATE TYPE "public"."agent_run_status" AS ENUM('queued', 'assigned', 'running', 'succeeded', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."platform" AS ENUM('github');--> statement-breakpoint
CREATE TABLE "agent_hosts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"capabilities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"spec" jsonb NOT NULL,
	"trigger_event_id" text,
	"status" "agent_run_status" DEFAULT 'queued' NOT NULL,
	"host_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"exit_code" integer
);
--> statement-breakpoint
CREATE TABLE "platform_events" (
	"id" text PRIMARY KEY NOT NULL,
	"platform" "platform" NOT NULL,
	"type" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_trigger_event_id_platform_events_id_fk" FOREIGN KEY ("trigger_event_id") REFERENCES "public"."platform_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_host_id_agent_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."agent_hosts"("id") ON DELETE no action ON UPDATE no action;