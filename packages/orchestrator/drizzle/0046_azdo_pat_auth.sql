-- Personal Access Token as a second credential mode for Azure DevOps.
--
-- Why this is needed at all: Azure DevOps registers itself in Entra with
-- signInAudience = AzureADMultipleOrgs, i.e. work/school accounts only. An
-- organization backed by a personal Microsoft account (the default when someone
-- creates one under an @outlook/@msn address and never connects a directory) is
-- therefore UNREACHABLE by Entra OAuth — no app configuration changes that. A
-- PAT is the only credential such an organization can issue.
--
-- Storage reuses `access_token_enc` for the PAT rather than adding a column:
-- both are "the secret we present to Azure DevOps", and the auth_mode
-- discriminator says how to present it (Bearer vs HTTP Basic). refresh_token_enc
-- and access_token_expires_at stay NULL for PAT — there is nothing to refresh,
-- which is also why AzureDevopsClient must not try.
ALTER TABLE "azure_devops_connections"
  ADD COLUMN "auth_mode" text DEFAULT 'entra' NOT NULL;--> statement-breakpoint

-- A PAT connection has no Entra identity behind it.
ALTER TABLE "azure_devops_connections" ALTER COLUMN "entra_object_id" DROP NOT NULL;--> statement-breakpoint

-- Optional operator-facing label, e.g. the PAT's expiry date, so a connection
-- that stops working has a visible reason rather than looking mysteriously dead.
ALTER TABLE "azure_devops_connections" ADD COLUMN "pat_expires_at" timestamp with time zone;--> statement-breakpoint

-- Keep the two modes internally consistent: entra connections must carry the
-- identity they were granted to; pat connections must not pretend to.
ALTER TABLE "azure_devops_connections" ADD CONSTRAINT "azure_devops_connections_auth_mode_ck" CHECK (
  ("auth_mode" = 'entra' AND "entra_object_id" IS NOT NULL)
  OR
  ("auth_mode" = 'pat' AND "entra_object_id" IS NULL AND "refresh_token_enc" IS NULL)
);
