import { Hono } from "hono";
import { ulid } from "ulid";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { azureDevopsConnections, projects, sessions } from "../../db/schema.js";
import { requireUser, type AuthEnv } from "../../auth/middleware.js";
import type { TokenCipher } from "../../auth/session.js";
import { tenantIdFromAccessToken, type EntraOAuth } from "../../azure/entra.js";
import { AzureDevopsClient, clientForConnection, AZDO_API_VERSION } from "../../azure/client.js";
import {
  azureCloneUrl,
  azureOwnerLabel,
  listOrganizations,
  listRepositories,
} from "../../azure/repos.js";
import { createSubscriptions, deleteSubscriptions } from "../../azure/hooks.js";

interface AzureRoutesDeps {
  db: Db;
  cipher: TokenCipher;
  /** Absent when only PAT connections are supported (no AZDO_ENTRA_*). */
  entra?: EntraOAuth;
  publicBaseUrl: string;
  cookieName: string;
}

/**
 * Connect an Azure DevOps organization and add repositories from it.
 *
 * Ownership model matches the GitHub side: every row is scoped to
 * `addedByUserId` and a miss answers 404 (never 403) so a client cannot probe
 * for ids in another user's account.
 */
export function azureRoutes(deps: AzureRoutesDeps) {
  const r = new Hono<AuthEnv>();
  r.use("*", requireUser());

  const clientDeps = { db: deps.db, cipher: deps.cipher, entra: deps.entra };

  /** Organizations the signed-in user could connect. */
  r.get("/organizations", async (c) => {
    const user = c.get("user")!;
    if (!deps.entra) {
      // Listing organizations is an Entra-only capability; PAT connections name
      // their organization explicitly instead.
      return c.json(
        {
          error:
            "Microsoft sign-in is not configured on this deployment — connect an organization with a Personal Access Token instead",
          code: "entra_not_configured",
        },
        409,
      );
    }
    const token = await sessionEntraToken(deps, c.req.header("cookie"));
    if (!token) {
      // The Entra token lives on the session, so a GitHub-authenticated user
      // has none. Point at the fix rather than 500ing.
      return c.json(
        {
          error:
            "no Microsoft credentials on this session — sign in with Microsoft to connect an Azure DevOps organization",
          code: "entra_signin_required",
        },
        409,
      );
    }
    try {
      const orgs = await listOrganizations(token);
      const connected = await deps.db.query.azureDevopsConnections.findMany({
        where: eq(azureDevopsConnections.addedByUserId, user.id),
      });
      const byName = new Map(connected.map((c2) => [c2.orgName, c2.id]));
      return c.json({
        organizations: orgs.map((o) => ({ ...o, connectionId: byName.get(o.name) ?? null })),
      });
    } catch (err) {
      console.error("[azure] organization listing failed", err);
      return c.json({ error: "could not list Azure DevOps organizations" }, 502);
    }
  });

  /** Connections this user already made. */
  r.get("/connections", async (c) => {
    const user = c.get("user")!;
    const rows = await deps.db.query.azureDevopsConnections.findMany({
      where: eq(azureDevopsConnections.addedByUserId, user.id),
    });
    // Never serialize the token or webhook-secret columns.
    return c.json({
      connections: rows.map((row) => ({
        id: row.id,
        orgName: row.orgName,
        orgId: row.orgId,
        authMode: row.authMode,
        patExpiresAt: row.patExpiresAt,
        createdAt: row.createdAt,
      })),
    });
  });

  /** Connect an organization, storing the session's Entra grant against it. */
  r.post("/connections", async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json().catch(() => ({}));
    const orgName = typeof body.orgName === "string" ? body.orgName.trim() : "";
    if (!orgName) return c.json({ error: "orgName (string) required" }, 400);

    const session = await sessionRow(deps, c.req.header("cookie"));
    if (!session?.entraAccessTokenEnc) {
      return c.json(
        {
          error:
            "no Microsoft credentials on this session — sign in with Microsoft to connect an Azure DevOps organization",
          code: "entra_signin_required",
        },
        409,
      );
    }

    const existing = await deps.db.query.azureDevopsConnections.findFirst({
      where: and(
        eq(azureDevopsConnections.addedByUserId, user.id),
        eq(azureDevopsConnections.orgName, orgName),
      ),
    });

    // Re-connecting refreshes the stored grant rather than erroring — that is
    // the recovery path when a refresh token has expired or consent was reset.
    const tokenFields = {
      accessTokenEnc: session.entraAccessTokenEnc,
      refreshTokenEnc: session.entraRefreshTokenEnc,
      accessTokenExpiresAt: session.entraTokenExpiresAt,
      updatedAt: new Date(),
    };

    if (existing) {
      await deps.db
        .update(azureDevopsConnections)
        .set(tokenFields)
        .where(eq(azureDevopsConnections.id, existing.id));
      return c.json({ connection: { id: existing.id, orgName, reconnected: true } });
    }

    let claims;
    try {
      claims = await entraClaimsFromSession(deps, session);
    } catch (err) {
      // Missing identity row — recoverable by re-authenticating, so answer with
      // the same affordance as a session that never had Microsoft credentials
      // rather than a bare 500.
      console.error("[azure] could not resolve Entra identity for connect", err);
      return c.json(
        {
          error: err instanceof Error ? err.message : "could not resolve Microsoft identity",
          code: "entra_signin_required",
        },
        409,
      );
    }
    const id = ulid();
    await deps.db.insert(azureDevopsConnections).values({
      id,
      orgName,
      entraTenantId: claims.tenantId,
      entraObjectId: claims.objectId,
      // 32 bytes of entropy; this is the ONLY authentication on inbound
      // service hooks (Azure DevOps does not sign deliveries).
      webhookSecretEnc: deps.cipher.encrypt(randomBytes(32).toString("hex")),
      addedByUserId: user.id,
      ...tokenFields,
    });
    return c.json({ connection: { id, orgName, reconnected: false } }, 201);
  });

  /**
   * Connect an organization with a Personal Access Token.
   *
   * The only way to reach an organization backed by a personal Microsoft
   * account: Azure DevOps is registered in Entra as work/school-only, so those
   * orgs can never issue an Entra token (see migration 0046).
   *
   * The PAT is verified against the organization BEFORE it is stored — a token
   * that is wrong, expired, or scoped to a different org fails here with a
   * clear message rather than silently producing a connection that 401s on
   * every later use.
   */
  r.post("/connections/pat", async (c) => {
    const user = c.get("user")!;
    const body = await c.req.json().catch(() => ({}));
    const orgName = typeof body.orgName === "string" ? body.orgName.trim() : "";
    const pat = typeof body.pat === "string" ? body.pat.trim() : "";
    if (!orgName || !pat) {
      return c.json({ error: "orgName and pat (strings) are required" }, 400);
    }
    // The org name goes into a URL path; keep it to what Azure DevOps allows.
    if (!/^[\w][\w.-]{0,62}$/.test(orgName)) {
      return c.json({ error: "orgName contains unexpected characters" }, 400);
    }

    const verify = await verifyPat(orgName, pat);
    if (!verify.ok) return c.json({ error: verify.error }, verify.status);

    const existing = await deps.db.query.azureDevopsConnections.findFirst({
      where: and(
        eq(azureDevopsConnections.addedByUserId, user.id),
        eq(azureDevopsConnections.orgName, orgName),
      ),
    });

    const patExpiresAt =
      typeof body.expiresAt === "string" && !Number.isNaN(Date.parse(body.expiresAt))
        ? new Date(body.expiresAt)
        : null;

    const fields = {
      authMode: "pat" as const,
      accessTokenEnc: deps.cipher.encrypt(pat),
      // A PAT has nothing to refresh; leaving these null is what the
      // auth_mode CHECK constraint enforces.
      refreshTokenEnc: null,
      accessTokenExpiresAt: null,
      entraObjectId: null,
      entraTenantId: null,
      patExpiresAt,
      updatedAt: new Date(),
    };

    if (existing) {
      // Rotating the PAT is the same action as connecting again. Submitting a
      // PAT for an org previously connected via Microsoft deliberately switches
      // it to token auth — a legitimate thing to want — but the response says
      // so rather than letting the mode change silently.
      const converted = existing.authMode !== "pat";
      await deps.db
        .update(azureDevopsConnections)
        .set(fields)
        .where(eq(azureDevopsConnections.id, existing.id));
      return c.json({
        connection: { id: existing.id, orgName, reconnected: true, convertedFromEntra: converted },
      });
    }

    const id = ulid();
    await deps.db.insert(azureDevopsConnections).values({
      id,
      orgName,
      webhookSecretEnc: deps.cipher.encrypt(randomBytes(32).toString("hex")),
      addedByUserId: user.id,
      ...fields,
    });
    return c.json({ connection: { id, orgName, reconnected: false } }, 201);
  });

  /** Repositories available under a connection. */
  r.get("/connections/:id/repositories", async (c) => {
    const user = c.get("user")!;
    const connection = await ownedConnection(deps.db, c.req.param("id"), user.id);
    if (!connection) return c.json({ error: "connection not found" }, 404);

    try {
      const client = new AzureDevopsClient(clientDeps, connection);
      const repos = await listRepositories(client);
      const added = await deps.db.query.projects.findMany({
        where: eq(projects.azdoConnectionId, connection.id),
      });
      const addedIds = new Set(added.map((p) => p.externalRepoId));
      return c.json({
        repositories: repos.map((repo) => ({ ...repo, added: addedIds.has(repo.id) })),
      });
    } catch (err) {
      console.error("[azure] repository listing failed", err);
      return c.json({ error: describeAzureError(err) }, 502);
    }
  });

  /** Add a repository as a project, and subscribe to its service hooks. */
  r.post("/connections/:id/projects", async (c) => {
    const user = c.get("user")!;
    const connection = await ownedConnection(deps.db, c.req.param("id"), user.id);
    if (!connection) return c.json({ error: "connection not found" }, 404);

    const body = await c.req.json().catch(() => ({}));
    const repositoryId = typeof body.repositoryId === "string" ? body.repositoryId : "";
    if (!repositoryId) return c.json({ error: "repositoryId (string) required" }, 400);

    const client = new AzureDevopsClient(clientDeps, connection);
    let repo;
    try {
      // Re-fetch rather than trusting client-supplied names: this is what binds
      // the stored project to a repository the user can actually see.
      const repos = await listRepositories(client);
      repo = repos.find((x) => x.id === repositoryId);
    } catch (err) {
      console.error("[azure] repository lookup failed", err);
      return c.json({ error: describeAzureError(err) }, 502);
    }
    if (!repo) return c.json({ error: "repository not found in this organization" }, 404);

    const existing = await deps.db.query.projects.findFirst({
      where: and(
        eq(projects.platform, "azure_devops"),
        eq(projects.externalRepoId, repo.id),
      ),
    });
    if (existing) return c.json({ project: existing, alreadyAdded: true });

    const webhookUrl = `${deps.publicBaseUrl}/webhooks/azure-devops`;
    let subscriptions;
    try {
      subscriptions = await createSubscriptions({
        client,
        projectId: repo.projectId,
        repositoryId: repo.id,
        webhookUrl,
        webhookSecret: deps.cipher.decrypt(connection.webhookSecretEnc),
      });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }

    // All-or-nothing: a project subscribed to only some of its events looks
    // healthy but silently misses triggers. Roll back what was created.
    if (subscriptions.errors.length > 0) {
      await deleteSubscriptions(
        client,
        subscriptions.created.map((s) => s.id),
      );
      const detail = subscriptions.errors
        .map((e) => `${e.eventType}: ${e.error}`)
        .join("; ");
      return c.json(
        { error: `could not subscribe to Azure DevOps events — ${detail}` },
        502,
      );
    }

    const id = ulid();
    await deps.db.insert(projects).values({
      id,
      platform: "azure_devops",
      azdoConnectionId: connection.id,
      azdoProjectId: repo.projectId,
      azdoSubscriptionIds: subscriptions.created.map((s) => s.id),
      externalRepoId: repo.id,
      owner: azureOwnerLabel(connection.orgName, repo.projectName),
      name: repo.name,
      webUrl: repo.webUrl,
      defaultBranch: repo.defaultBranch,
      private: repo.isPrivate,
      addedByUserId: user.id,
      instructionsFile: "",
    });

    return c.json(
      {
        project: {
          id,
          platform: "azure_devops",
          owner: azureOwnerLabel(connection.orgName, repo.projectName),
          name: repo.name,
          webUrl: repo.webUrl,
          cloneUrl: azureCloneUrl(connection.orgName, repo.projectName, repo.name),
        },
      },
      201,
    );
  });

  return r;

  // -- helpers ------------------------------------------------------------

  async function sessionRow(d: AzureRoutesDeps, cookieHeader: string | undefined) {
    const sid = readCookie(cookieHeader, d.cookieName);
    if (!sid) return null;
    return (await d.db.query.sessions.findFirst({ where: eq(sessions.id, sid) })) ?? null;
  }

  async function sessionEntraToken(
    d: AzureRoutesDeps,
    cookieHeader: string | undefined,
  ): Promise<string | null> {
    const row = await sessionRow(d, cookieHeader);
    if (!row?.entraAccessTokenEnc) return null;
    const fresh =
      row.entraTokenExpiresAt && row.entraTokenExpiresAt.getTime() - 60_000 > Date.now();
    if (fresh) return d.cipher.decrypt(row.entraAccessTokenEnc);
    // No Entra client means no way to refresh; the stale token is unusable.
    if (!row.entraRefreshTokenEnc || !d.entra) return null;
    const entra = d.entra;
    try {
      const tokens = await entra.refresh(d.cipher.decrypt(row.entraRefreshTokenEnc));
      await d.db
        .update(sessions)
        .set({
          entraAccessTokenEnc: d.cipher.encrypt(tokens.accessToken),
          entraTokenExpiresAt: tokens.expiresAt,
          ...(tokens.refreshToken
            ? { entraRefreshTokenEnc: d.cipher.encrypt(tokens.refreshToken) }
            : {}),
        })
        .where(eq(sessions.id, row.id));
      return tokens.accessToken;
    } catch (err) {
      console.error("[azure] session token refresh failed", err);
      return null;
    }
  }

  async function entraClaimsFromSession(
    d: AzureRoutesDeps,
    session: typeof sessions.$inferSelect,
  ): Promise<{ tenantId: string | null; objectId: string }> {
    // The identity row written at sign-in is the authoritative record of who
    // this is — its externalId IS the Entra `oid`.
    const identity = await d.db.query.userIdentities.findFirst({
      where: (t, { and: a, eq: e }) =>
        a(e(t.userId, session.userId), e(t.provider, "entra")),
    });
    // The `tid` claim is readable off the session's access token, so the tenant
    // needs no extra round-trip and no extra column. Null when it can't be
    // parsed — recording "unknown" as a string would look like real data.
    const tenantId = session.entraAccessTokenEnc
      ? tenantIdFromAccessToken(d.cipher.decrypt(session.entraAccessTokenEnc))
      : null;
    if (!identity) {
      // Unreachable in practice: a session carrying entraAccessTokenEnc got it
      // from the Entra callback, which writes the identity row first. Falling
      // back to session.userId would write an internal ULID into
      // `entra_object_id` — a column whose whole meaning is "Entra oid" — so
      // fail loudly rather than persist something that isn't what it claims.
      throw new Error(
        "entra identity row missing for a session with Microsoft credentials — sign in with Microsoft again",
      );
    }
    return { objectId: identity.externalId, tenantId };
  }
}


/**
 * Check a PAT actually works against the organization, before storing it.
 *
 * Uses the projects endpoint because it needs only read access and exists on
 * every organization. Distinguishes the three failures an operator can act on:
 * wrong/expired token, wrong organization name, and everything else.
 */
async function verifyPat(
  orgName: string,
  pat: string,
): Promise<{ ok: true } | { ok: false; error: string; status: 400 | 401 | 404 | 502 }> {
  const url = `https://dev.azure.com/${encodeURIComponent(orgName)}/_apis/projects?api-version=${AZDO_API_VERSION}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        authorization: `Basic ${Buffer.from(`:${pat}`).toString("base64")}`,
        accept: "application/json",
      },
      redirect: "manual",
    });
  } catch (err) {
    return {
      ok: false,
      status: 502,
      error: `could not reach Azure DevOps: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (res.ok) return { ok: true };
  // Azure DevOps answers an unauthenticated request with a 302 to a sign-in
  // page rather than a 401, so treat a redirect as bad credentials.
  if (res.status === 401 || res.status === 203 || (res.status >= 300 && res.status < 400)) {
    return {
      ok: false,
      status: 401,
      error: `Azure DevOps rejected that token for organization '${orgName}'. Check the token is valid, not expired, and issued for this organization.`,
    };
  }
  if (res.status === 404) {
    return {
      ok: false,
      status: 404,
      error: `organization '${orgName}' not found at dev.azure.com`,
    };
  }
  return {
    ok: false,
    status: 502,
    error: `Azure DevOps returned ${res.status} while verifying the token`,
  };
}

async function ownedConnection(db: Db, id: string, userId: string) {
  return (
    (await db.query.azureDevopsConnections.findFirst({
      where: and(
        eq(azureDevopsConnections.id, id),
        eq(azureDevopsConnections.addedByUserId, userId),
      ),
    })) ?? null
  );
}

function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=");
  }
  return null;
}

/** Surface reconnect-required distinctly from a transient API failure. */
function describeAzureError(err: unknown): string {
  if (err instanceof Error && err.name === "AzureDevopsAuthError") return err.message;
  return err instanceof Error ? err.message : String(err);
}
