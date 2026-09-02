-- Allow azure_devops_connections.entra_tenant_id to be NULL.
--
-- 0043 declared it NOT NULL on the assumption the connect flow would know the
-- directory a grant came from. It doesn't: connect runs from a session, and the
-- id token carrying the `tid` claim is consumed at sign-in and not persisted.
-- The code was filling it with the literal string 'unknown', which is worse
-- than a NULL — it looks like data.
--
-- The tenant is now read best-effort from the `tid` claim of the session's
-- Entra access token (a JWT for the Azure DevOps resource). When that cannot be
-- parsed, NULL records "we don't know" honestly.
--
-- Nothing reads this column for behaviour: token refresh goes through the
-- shared EntraOAuth built from AZDO_ENTRA_TENANT, not from here. It is
-- diagnostic metadata ("which directory is this org's grant from?").
ALTER TABLE "azure_devops_connections" ALTER COLUMN "entra_tenant_id" DROP NOT NULL;--> statement-breakpoint

-- Clear the placeholder written by the pre-fix code path.
UPDATE "azure_devops_connections" SET "entra_tenant_id" = NULL WHERE "entra_tenant_id" = 'unknown';
