CREATE TABLE "flow_node_settings" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"flow_id" text NOT NULL,
	"node_id" text NOT NULL,
	"prompt_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flow_node_settings" ADD CONSTRAINT "flow_node_settings_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_node_settings" ADD CONSTRAINT "flow_node_settings_flow_id_flows_id_fk" FOREIGN KEY ("flow_id") REFERENCES "public"."flows"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "flow_node_settings" ADD CONSTRAINT "flow_node_settings_prompt_id_prompts_id_fk" FOREIGN KEY ("prompt_id") REFERENCES "public"."prompts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "flow_node_settings_flow_node_uq" ON "flow_node_settings" USING btree ("flow_id","node_id");--> statement-breakpoint
CREATE UNIQUE INDEX "prompts_project_name_uq" ON "prompts" USING btree ("project_id","name");--> statement-breakpoint
CREATE INDEX "prompts_project_id_idx" ON "prompts" USING btree ("project_id");