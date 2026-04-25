CREATE TYPE "public"."github_account_type" AS ENUM('User', 'Organization');--> statement-breakpoint
CREATE TABLE "github_installations" (
	"id" text PRIMARY KEY NOT NULL,
	"github_installation_id" bigint NOT NULL,
	"account_type" "github_account_type" NOT NULL,
	"account_login" text NOT NULL,
	"account_id" bigint NOT NULL,
	"target_type" text NOT NULL,
	"repository_selection" text NOT NULL,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"suspended_at" timestamp with time zone,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" text PRIMARY KEY NOT NULL,
	"installation_id" text NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"owner" text NOT NULL,
	"name" text NOT NULL,
	"default_branch" text,
	"private" boolean DEFAULT false NOT NULL,
	"added_by_user_id" text,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"removed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"github_access_token_enc" text NOT NULL,
	"github_refresh_token_enc" text,
	"github_token_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"github_user_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"email" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_runs" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "platform_events" ADD COLUMN "installation_id" text;--> statement-breakpoint
ALTER TABLE "platform_events" ADD COLUMN "project_id" text;--> statement-breakpoint
ALTER TABLE "platform_events" ADD COLUMN "github_repo_id" bigint;--> statement-breakpoint
ALTER TABLE "platform_events" ADD COLUMN "delivery_id" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_github_installation_id_uq" ON "github_installations" USING btree ("github_installation_id");--> statement-breakpoint
CREATE INDEX "github_installations_account_login_idx" ON "github_installations" USING btree ("account_login");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_github_repo_id_uq" ON "projects" USING btree ("github_repo_id");--> statement-breakpoint
CREATE UNIQUE INDEX "projects_owner_name_uq" ON "projects" USING btree ("owner","name");--> statement-breakpoint
CREATE INDEX "projects_installation_id_idx" ON "projects" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_github_user_id_uq" ON "users" USING btree ("github_user_id");--> statement-breakpoint
CREATE INDEX "users_github_login_idx" ON "users" USING btree ("github_login");--> statement-breakpoint
ALTER TABLE "agent_runs" ADD CONSTRAINT "agent_runs_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_events" ADD CONSTRAINT "platform_events_installation_id_github_installations_id_fk" FOREIGN KEY ("installation_id") REFERENCES "public"."github_installations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform_events" ADD CONSTRAINT "platform_events_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_project_id_created_at_idx" ON "agent_runs" USING btree ("project_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "platform_events_project_id_received_at_idx" ON "platform_events" USING btree ("project_id","received_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "platform_events_installation_id_idx" ON "platform_events" USING btree ("installation_id");