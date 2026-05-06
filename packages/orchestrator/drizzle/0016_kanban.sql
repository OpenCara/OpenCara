-- Phase 1 of GitHub Projects v2 Kanban (issue #7).
--
-- Two tables:
--
--   project_v2_links — one row per (opencara project) ↔ (Projects v2 board)
--     mirror. v1 enforces one board per project via the partial-less unique
--     index on project_id. status_options caches the Status single-select
--     field's options (id+name+color+position) so the UI can lay out columns
--     without a second GraphQL hop.
--
--   project_v2_items — local mirror of items on the linked board. Idempotent
--     upserts via unique(project_v2_link_id, github_item_node_id), used by
--     both the GraphQL backfill and the projects_v2_item webhook handler.
--     status_option_id is the value of the Status field — a string id from
--     project_v2_links.status_options[].optionId.

CREATE TABLE "project_v2_links" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"github_project_node_id" text NOT NULL,
	"github_project_number" integer NOT NULL,
	"github_project_owner" text NOT NULL,
	"github_project_title" text NOT NULL,
	"status_field_node_id" text NOT NULL,
	"status_options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_synced_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_v2_links" ADD CONSTRAINT "project_v2_links_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_v2_links_project_id_uq" ON "project_v2_links" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "project_v2_links_github_project_node_id_idx" ON "project_v2_links" USING btree ("github_project_node_id");--> statement-breakpoint

CREATE TABLE "project_v2_items" (
	"id" text PRIMARY KEY NOT NULL,
	"project_v2_link_id" text NOT NULL,
	"github_item_node_id" text NOT NULL,
	"kind" text NOT NULL,
	"content_node_id" text,
	"content_number" integer,
	"content_title" text NOT NULL,
	"content_url" text,
	"content_state" text,
	"status_option_id" text,
	"archived_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "project_v2_items" ADD CONSTRAINT "project_v2_items_project_v2_link_id_project_v2_links_id_fk" FOREIGN KEY ("project_v2_link_id") REFERENCES "public"."project_v2_links"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_v2_items_link_item_uq" ON "project_v2_items" USING btree ("project_v2_link_id","github_item_node_id");--> statement-breakpoint
CREATE INDEX "project_v2_items_link_status_idx" ON "project_v2_items" USING btree ("project_v2_link_id","status_option_id");
