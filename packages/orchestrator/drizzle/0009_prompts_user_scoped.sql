-- Move prompts from per-project to per-user; add labels for filtering.
-- Custom-authored (not via drizzle-kit generate) so we can backfill the
-- existing project-scoped rows onto the first user before flipping the
-- NOT NULL + FK constraints.

ALTER TABLE "prompts" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "prompts" ADD COLUMN "labels" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint

-- Backfill: assign every existing prompt to the first user. Single-tenant
-- homelab assumption; multi-user installs would need a smarter mapping.
UPDATE "prompts" SET "user_id" = (SELECT "id" FROM "users" ORDER BY "created_at" LIMIT 1) WHERE "user_id" IS NULL;--> statement-breakpoint

-- Drop any rows we couldn't attribute (no users in DB) so the NOT NULL
-- below succeeds.
DELETE FROM "prompts" WHERE "user_id" IS NULL;--> statement-breakpoint

ALTER TABLE "prompts" ALTER COLUMN "user_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "prompts" ADD CONSTRAINT "prompts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Old project-scoped artefacts go away.
DROP INDEX IF EXISTS "prompts_project_name_uq";--> statement-breakpoint
DROP INDEX IF EXISTS "prompts_project_id_idx";--> statement-breakpoint
ALTER TABLE "prompts" DROP CONSTRAINT IF EXISTS "prompts_project_id_projects_id_fk";--> statement-breakpoint
ALTER TABLE "prompts" DROP COLUMN IF EXISTS "project_id";--> statement-breakpoint

CREATE UNIQUE INDEX "prompts_user_name_uq" ON "prompts" ("user_id","name");--> statement-breakpoint
CREATE INDEX "prompts_user_id_idx" ON "prompts" ("user_id");
