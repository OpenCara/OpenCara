CREATE TABLE "agents" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"command" text NOT NULL,
	"args" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"env" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"cwd" text,
	"run_on" text DEFAULT 'any' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "flow_node_settings" ADD COLUMN "agent_id" text;--> statement-breakpoint
ALTER TABLE "agents" ADD CONSTRAINT "agents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agents_user_name_uq" ON "agents" USING btree ("user_id","name");--> statement-breakpoint
CREATE INDEX "agents_user_id_idx" ON "agents" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "flow_node_settings" ADD CONSTRAINT "flow_node_settings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE set null ON UPDATE no action;