-- Azure DevOps support: connection rows, multi-provider user identities, and
-- the project columns that let a project belong to either platform.
--
-- Shape decision: side-by-side rather than generalising `github_installations`
-- into a shared `platform_connections` table. GitHub's model (an App
-- installation, webhook-created, shared by everyone in the org) and Azure
-- DevOps' (a user-delegated Entra grant, always created by a signed-in user)
-- have little in common beyond "credentials for a remote". Keeping them apart
-- costs a two-branch fork on the project→connection join; merging them would
-- have cost a nullable column per platform-specific field on every row.
--
-- The CHECK on `projects` is what keeps that fork honest: a project points at
-- exactly one connection, matching its platform. Without it the two nullable
-- FKs could silently drift into "both set" or "neither set".

-- ---------------------------------------------------------------------------
-- Multi-provider identity
-- ---------------------------------------------------------------------------
-- Until now a user WAS a GitHub account (users.github_user_id, NOT NULL +
-- UNIQUE). Sign-in with Entra means a user can exist with no GitHub identity at
-- all, so identities move to their own table and the columns on `users` become
-- a nullable cache of the GitHub one (still read directly in a handful of
-- display paths).
CREATE TABLE "user_identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	-- 'github' | 'entra'. Free text rather than an enum: identity providers are
	-- expected to come and go faster than platforms, and an enum ADD VALUE needs
	-- its own migration (see 0042).
	"provider" text NOT NULL,
	-- Provider-native stable id: GitHub's numeric user id, Entra's `oid` claim.
	-- Stored as text because the two have different shapes.
	"external_id" text NOT NULL,
	-- Human-facing handle: GitHub login, Entra userPrincipalName.
	"login" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- One account per (provider, external id) — this is the lookup key on sign-in.
CREATE UNIQUE INDEX "user_identities_provider_external_id_uq" ON "user_identities" USING btree ("provider","external_id");--> statement-breakpoint
CREATE INDEX "user_identities_user_id_idx" ON "user_identities" USING btree ("user_id");--> statement-breakpoint

-- Backfill every existing user as a GitHub identity. Idempotent: re-running the
-- migration cannot duplicate rows.
INSERT INTO "user_identities" ("id", "user_id", "provider", "external_id", "login")
SELECT
	'ui_' || "id",
	"id",
	'github',
	"github_user_id"::text,
	"github_login"
FROM "users"
WHERE "github_user_id" IS NOT NULL
ON CONFLICT ("provider", "external_id") DO NOTHING;--> statement-breakpoint

-- A user signing in with Entra has no GitHub account.
ALTER TABLE "users" ALTER COLUMN "github_user_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "github_login" DROP NOT NULL;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Sessions
-- ---------------------------------------------------------------------------
-- An Entra-authenticated session carries no GitHub token.
ALTER TABLE "sessions" ALTER COLUMN "github_access_token_enc" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "auth_provider" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
-- Entra tokens for the *signed-in user*, used to enumerate the organizations
-- they can connect. Distinct from the per-connection tokens below, which are
-- what actually drives repo/PR traffic.
ALTER TABLE "sessions" ADD COLUMN "entra_access_token_enc" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "entra_refresh_token_enc" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "entra_token_expires_at" timestamp with time zone;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Azure DevOps connections
-- ---------------------------------------------------------------------------
CREATE TABLE "azure_devops_connections" (
	"id" text PRIMARY KEY NOT NULL,
	-- Organization as it appears in the URL: https://dev.azure.com/<org_name>.
	"org_name" text NOT NULL,
	-- Azure DevOps accountId GUID. Nullable because the org can be connected by
	-- name before the accounts lookup resolves.
	"org_id" text,
	-- Entra directory + the connecting user's object id, so a token refresh can
	-- be issued against the right tenant.
	"entra_tenant_id" text NOT NULL,
	"entra_object_id" text NOT NULL,
	-- Encrypted with the same TokenCipher (SESSION_ENCRYPTION_KEY) as session
	-- tokens. The refresh token is the long-lived secret; the access token is a
	-- ~1h cache refreshed in place.
	"refresh_token_enc" text,
	"access_token_enc" text,
	"access_token_expires_at" timestamp with time zone,
	-- Shared secret for inbound service hooks. Azure DevOps authenticates
	-- webhooks with HTTP Basic rather than an HMAC signature, so this is the
	-- password we register on each subscription and compare on delivery.
	"webhook_secret_enc" text NOT NULL,
	-- NOT NULL, unlike github_installations.added_by_user_id: an ADO connection
	-- only ever comes into existence through a signed-in user completing OAuth,
	-- never through an unattributed webhook. Its credentials ARE that user's, so
	-- the row is meaningless without them — hence CASCADE, not SET NULL.
	"added_by_user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "azure_devops_connections" ADD CONSTRAINT "azure_devops_connections_added_by_user_id_users_id_fk" FOREIGN KEY ("added_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
-- Scoped per user, not globally: because the credentials are user-delegated,
-- two people connecting the same organization legitimately hold two different
-- grants. (Contrast github_installations, where one App installation really is
-- shared by the whole org.)
CREATE UNIQUE INDEX "azure_devops_connections_user_org_uq" ON "azure_devops_connections" USING btree ("added_by_user_id","org_name");--> statement-breakpoint
CREATE INDEX "azure_devops_connections_org_name_idx" ON "azure_devops_connections" USING btree ("org_name");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
ALTER TABLE "projects" ADD COLUMN "platform" "platform" DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ADD COLUMN "azdo_connection_id" text;--> statement-breakpoint
-- Platform-neutral repo identity. GitHub repo ids are bigints; Azure DevOps
-- repository ids are GUIDs. Text holds both.
ALTER TABLE "projects" ADD COLUMN "external_repo_id" text;--> statement-breakpoint
-- Canonical browser URL. Previously derived as github.com/{owner}/{name}, which
-- is not derivable for Azure DevOps (org/project/_git/repo).
ALTER TABLE "projects" ADD COLUMN "web_url" text;--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_azdo_connection_id_fk" FOREIGN KEY ("azdo_connection_id") REFERENCES "public"."azure_devops_connections"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint

-- Backfill before adding the constraints that depend on these being populated.
UPDATE "projects" SET "external_repo_id" = "github_repo_id"::text WHERE "external_repo_id" IS NULL;--> statement-breakpoint
UPDATE "projects" SET "web_url" = 'https://github.com/' || "owner" || '/' || "name" WHERE "web_url" IS NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "external_repo_id" SET NOT NULL;--> statement-breakpoint

-- An Azure DevOps project has no GitHub installation or repo id.
ALTER TABLE "projects" ALTER COLUMN "installation_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "projects" ALTER COLUMN "github_repo_id" DROP NOT NULL;--> statement-breakpoint

-- Exactly one connection, matching the platform. This is what makes the
-- two-nullable-FK model safe to join through.
--
-- `"platform"::text` rather than the bare enum literal is REQUIRED, not stylistic:
-- 0042 adds 'azure_devops' to the enum, drizzle runs all pending migrations in a
-- single transaction, and Postgres rejects use of a new enum value inside the
-- transaction that added it. Casting to text sidesteps that. See 0042's header
-- for why a from-scratch migration test does not catch this.
ALTER TABLE "projects" ADD CONSTRAINT "projects_platform_connection_ck" CHECK (
	("platform"::text = 'github' AND "installation_id" IS NOT NULL AND "azdo_connection_id" IS NULL)
	OR
	("platform"::text = 'azure_devops' AND "azdo_connection_id" IS NOT NULL AND "installation_id" IS NULL)
);--> statement-breakpoint

-- Repo identity is now (platform, external_repo_id). The old
-- projects_github_repo_id_uq stays as-is: it still guards GitHub rows, and
-- Postgres allows many NULLs, so Azure DevOps rows don't collide under it.
CREATE UNIQUE INDEX "projects_platform_external_repo_id_uq" ON "projects" USING btree ("platform","external_repo_id");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Platform events
-- ---------------------------------------------------------------------------
ALTER TABLE "platform_events" ADD COLUMN "azdo_connection_id" text;--> statement-breakpoint
ALTER TABLE "platform_events" ADD CONSTRAINT "platform_events_azdo_connection_id_fk" FOREIGN KEY ("azdo_connection_id") REFERENCES "public"."azure_devops_connections"("id") ON DELETE set null ON UPDATE no action;
