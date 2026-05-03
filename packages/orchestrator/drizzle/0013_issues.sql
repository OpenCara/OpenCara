-- Normalized issue rows so the project page can render an Issues tab
-- without parsing platform_events JSONB, and so the
-- github.projects_v2_item trigger can join issue context by node id.
-- Populated by webhooks (issues.opened|edited|labeled|assigned|...) and
-- by a one-shot REST backfill on project add.

CREATE TABLE "issues" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"github_issue_id" bigint NOT NULL,
	"github_node_id" text NOT NULL,
	"number" integer NOT NULL,
	"title" text NOT NULL,
	"body_md" text,
	"state" text NOT NULL,
	"state_reason" text,
	"labels" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"assignees" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"author_login" text,
	"html_url" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"closed_at" timestamp with time zone,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "issues" ADD CONSTRAINT "issues_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "issues_project_id_number_uq" ON "issues" USING btree ("project_id","number");--> statement-breakpoint
CREATE INDEX "issues_project_id_state_idx" ON "issues" USING btree ("project_id","state");--> statement-breakpoint
CREATE INDEX "issues_github_node_id_idx" ON "issues" USING btree ("github_node_id");
