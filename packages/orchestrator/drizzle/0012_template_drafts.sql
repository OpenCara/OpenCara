-- Per-user editable overlay over a builtin flow template's graphJson, plus
-- per-user node settings (linked agent/prompt/label) for templates. Used by
-- the seeder to give a new project flow inherited defaults from whatever the
-- project owner saved on the template page.

CREATE TABLE "template_drafts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"template_slug" text NOT NULL,
	"graph_json" jsonb NOT NULL,
	"customized_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "template_node_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"template_slug" text NOT NULL,
	"node_id" text NOT NULL,
	"prompt_id" text,
	"agent_id" text,
	"label" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "template_drafts" ADD CONSTRAINT "template_drafts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_node_settings" ADD CONSTRAINT "template_node_settings_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_node_settings" ADD CONSTRAINT "template_node_settings_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "template_node_settings" ADD CONSTRAINT "template_node_settings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "template_drafts_user_slug_uq" ON "template_drafts" USING btree ("user_id","template_slug");--> statement-breakpoint
CREATE UNIQUE INDEX "template_node_settings_user_slug_node_uq" ON "template_node_settings" USING btree ("user_id","template_slug","node_id");
