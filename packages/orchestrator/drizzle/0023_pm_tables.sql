-- PM Agent tables (issue #72).
--
--   pm_sessions — one row per opencara project; persists the ongoing PM
--     conversation thread (threadKey = stable sessionId for --resume) and the
--     user's last PM agent pick.
--
--   pm_waves — one row per batch dispatch; a PM turn that dispatches N issues
--     to a flow. status: running | done | cancelled.
--
--   pm_wave_items — individual issue dispatch items within a wave.
--     status: pending | running | succeeded | failed | cancelled.

CREATE TABLE "pm_sessions" (
  "project_id" text PRIMARY KEY NOT NULL,
  "thread_key" text NOT NULL,
  "agent_id" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pm_sessions" ADD CONSTRAINT "pm_sessions_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint

CREATE TABLE "pm_waves" (
  "id" text PRIMARY KEY NOT NULL,
  "project_id" text NOT NULL,
  "thread_key" text NOT NULL,
  "flow_slug" text NOT NULL,
  "status" text NOT NULL,
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "pm_waves" ADD CONSTRAINT "pm_waves_project_id_projects_id_fk"
  FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "pm_waves_project_status_idx" ON "pm_waves" USING btree ("project_id", "status");
--> statement-breakpoint

CREATE TABLE "pm_wave_items" (
  "id" text PRIMARY KEY NOT NULL,
  "wave_id" text NOT NULL,
  "issue_number" integer NOT NULL,
  "flow_run_id" text,
  "status" text NOT NULL
);
--> statement-breakpoint
ALTER TABLE "pm_wave_items" ADD CONSTRAINT "pm_wave_items_wave_id_pm_waves_id_fk"
  FOREIGN KEY ("wave_id") REFERENCES "public"."pm_waves"("id") ON DELETE cascade ON UPDATE no action;
