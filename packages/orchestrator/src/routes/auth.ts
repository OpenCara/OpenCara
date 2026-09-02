import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { ulid } from "ulid";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { azureDevopsConnections, githubInstallations } from "../db/schema.js";
import type { GithubOAuth } from "../github/oauth.js";
import type { GithubAppClient } from "../github/app.js";
import {
  upsertUser,
  upsertUserByIdentity,
  linkIdentityToUser,
  listUserIdentities,
  unlinkIdentity,
  attachEntraTokensToSession,
  clearEntraTokensFromSession,
  createSession,
  createEntraSession,
  destroySession,
  type TokenCipher,
} from "../auth/session.js";
import type { AuthEnv } from "../auth/middleware.js";
import type { SessionCache } from "../auth/sessionCache.js";
import { upsertInstallation } from "../github/installations.js";
import { parseIdTokenClaims, type EntraOAuth } from "../azure/entra.js";

interface AuthRouteDeps {
  db: Db;
  /** Absent on an Azure-DevOps-only deployment; the /auth/github/* routes are
   *  then not mounted and the login page offers Microsoft alone. */
  oauth?: GithubOAuth;
  cipher: TokenCipher;
  cookieName: string;
  ttlDays: number;
  publicBaseUrl: string;
  app?: GithubAppClient;
  sessionCache?: SessionCache;
  /** Present only when AZDO_ENTRA_* is configured. */
  entraOAuth?: EntraOAuth;
}

const STATE_COOKIE = "ocara_oauth_state";
// Separate from STATE_COOKIE so two sign-ins started in different tabs (one
// GitHub, one Entra) don't overwrite each other's CSRF state.
const ENTRA_STATE_COOKIE = "ocara_entra_oauth_state";
// Distinct from the sign-in state cookie so the callback can tell the two
// intents apart. Which cookie the state matches IS the mode — the mode is
// never read from a query parameter, which the caller could tamper with.
const ENTRA_LINK_STATE_COOKIE = "ocara_entra_link_state";
const STATE_TTL_SEC = 60 * 5;
const REDIRECT_AFTER_LOGIN = "/";

export function authRoutes(deps: AuthRouteDeps) {
  const r = new Hono<AuthEnv>();

  // GitHub sign-in, mounted only when a GitHub App is configured. Everything
  // below the `if` (logout, /api/me, /api/auth/providers) is platform-neutral
  // and always mounts.
  if (deps.oauth) {
    const oauth = deps.oauth;

    r.get("/auth/github/login", (c) => {
      const state = randomBytes(16).toString("base64url");
      setCookie(c, STATE_COOKIE, state, {
        httpOnly: true,
        secure: deps.publicBaseUrl.startsWith("https://"),
        sameSite: "Lax",
        path: "/",
        maxAge: STATE_TTL_SEC,
      });
      return c.redirect(oauth.buildAuthorizeUrl(state));
    });

    r.get("/auth/github/callback", async (c) => {
      const code = c.req.query("code");
      const state = c.req.query("state");
      const cookieState = getCookie(c, STATE_COOKIE);
      deleteCookie(c, STATE_COOKIE, { path: "/" });

      if (!code || !state || !cookieState || cookieState !== state) {
        return c.redirect("/login?error=oauth_state_mismatch");
      }

      try {
        const tokens = await oauth.exchangeCode(code);
        const viewer = await oauth.getViewer(tokens.accessToken);
        const user = await upsertUser(deps.db, viewer);
        const { sessionId, expiresAt } = await createSession(
          deps.db,
          deps.cipher,
          user.id,
          tokens,
          deps.ttlDays,
        );
        setCookie(c, deps.cookieName, sessionId, {
          httpOnly: true,
          secure: deps.publicBaseUrl.startsWith("https://"),
          sameSite: "Lax",
          path: "/",
          expires: expiresAt,
        });
        return c.redirect(REDIRECT_AFTER_LOGIN);
      } catch (err) {
        console.error("[auth] callback error", err);
        return c.redirect("/login?error=oauth_failed");
      }
    });

    r.get("/auth/github/setup", async (c) => {
      const installationIdParam = c.req.query("installation_id");
      if (!installationIdParam || !deps.app) {
        return c.redirect("/projects/new");
      }
      const installationId = Number.parseInt(installationIdParam, 10);
      if (Number.isFinite(installationId)) {
        try {
          // GET /app/installations/{id} is an App-level endpoint — it must
          // be authenticated with the App JWT, not an installation token.
          // `deps.app.app` carries the createAppAuth strategy which picks
          // the right credential per endpoint; `forInstallation()` would
          // attach a `ghs_...` token and GitHub would reject it with
          // "A JSON web token could not be decoded", silently aborting the
          // claim of the addedByUserId row.
          const res = await deps.app.app.request(
            "GET /app/installations/{installation_id}",
            { installation_id: installationId },
          );
          // The currentUser middleware runs ahead of this route, so the
          // cookie session (if any) is already loaded. Attribute the
          // installation to the user who just round-tripped through GitHub's
          // setup screen — this is the only point in the flow where we
          // reliably know who initiated the install. upsertInstallation
          // refuses to overwrite a row that's already attributed.
          const sessionUser = c.get("user");
          await upsertInstallation(
            deps.db,
            {
              id: res.data.id,
              account: res.data.account
                ? {
                    id: (res.data.account as { id: number }).id,
                    login: (res.data.account as { login?: string; slug?: string }).login ??
                      (res.data.account as { slug?: string }).slug ??
                      "unknown",
                    type: (res.data.account as { type?: string }).type,
                  }
                : undefined,
              target_type: res.data.target_type,
              repository_selection: res.data.repository_selection,
              permissions: res.data.permissions as Record<string, string>,
              events: res.data.events,
              suspended_at: res.data.suspended_at ?? null,
            },
            { addedByUserId: sessionUser?.id ?? null },
          );
        } catch (err) {
          console.error("[auth] setup sync error", err);
        }
      }
      return c.redirect("/projects/new");
    });

  }

  // ---------------------------------------------------------------------
  // Microsoft Entra ID — sign-in for Azure DevOps users
  // ---------------------------------------------------------------------
  // Mounted only when AZDO_ENTRA_* is configured; without it the login page
  // shows GitHub alone. Uses its own state cookie so an in-flight GitHub
  // login and an in-flight Entra login can't clobber each other's CSRF token.
  if (deps.entraOAuth) {
    const entra = deps.entraOAuth;

    r.get("/auth/azure/login", (c) => {
      const state = randomBytes(16).toString("base64url");
      setCookie(c, ENTRA_STATE_COOKIE, state, {
        httpOnly: true,
        secure: deps.publicBaseUrl.startsWith("https://"),
        sameSite: "Lax",
        path: "/",
        maxAge: STATE_TTL_SEC,
      });
      return c.redirect(entra.buildAuthorizeUrl(state));
    });

    // Link Microsoft to the account you are ALREADY signed in as, rather than
    // signing in as a separate one. This is what makes an Azure DevOps project
    // land under an existing GitHub account: every downstream row
    // (azure_devops_connections, projects) keys on user.id, and the Azure API
    // routes read the Entra token off the current session — so attaching both
    // to the signed-in user is the whole of it.
    r.get("/auth/azure/link", (c) => {
      const user = c.get("user");
      if (!user) return c.redirect("/login");
      const state = randomBytes(16).toString("base64url");
      setCookie(c, ENTRA_LINK_STATE_COOKIE, state, {
        httpOnly: true,
        secure: deps.publicBaseUrl.startsWith("https://"),
        sameSite: "Lax",
        path: "/",
        maxAge: STATE_TTL_SEC,
      });
      return c.redirect(entra.buildAuthorizeUrl(state));
    });

    r.get("/auth/azure/callback", async (c) => {
      const code = c.req.query("code");
      const state = c.req.query("state");
      const loginState = getCookie(c, ENTRA_STATE_COOKIE);
      const linkState = getCookie(c, ENTRA_LINK_STATE_COOKIE);
      deleteCookie(c, ENTRA_STATE_COOKIE, { path: "/" });
      deleteCookie(c, ENTRA_LINK_STATE_COOKIE, { path: "/" });

      // The mode is whichever cookie the state matches. Deriving it from the
      // cookie rather than a query param means a caller cannot ask for link
      // mode; they can only complete a flow this server started.
      const isLink = Boolean(state && linkState && linkState === state);
      const isLogin = Boolean(state && loginState && loginState === state);
      if (!code || (!isLink && !isLogin)) {
        return c.redirect(
          isLink ? "/settings?error=oauth_state_mismatch" : "/login?error=oauth_state_mismatch",
        );
      }
      const failRedirect = isLink ? "/settings?error=oauth_failed" : "/login?error=oauth_failed";

      try {
        const tokens = await entra.exchangeCode(code);
        if (!tokens.idToken) {
          // Without an id token there is no verified identity to key the
          // account on. Treat as a failure rather than inventing one from the
          // access token.
          console.error("[auth] entra callback returned no id_token");
          return c.redirect(failRedirect);
        }
        const profile = parseIdTokenClaims(tokens.idToken);
        const identity = {
          provider: "entra" as const,
          externalId: profile.objectId,
          login: profile.login,
          name: profile.name,
          email: profile.email,
          // Entra exposes a photo only via a separate Graph call that needs
          // its own permission; not worth a round-trip on every sign-in.
          avatarUrl: null,
        };

        if (isLink) {
          const sessionUser = c.get("user");
          const sid = getCookie(c, deps.cookieName);
          if (!sessionUser || !sid) {
            // Session expired mid-flow. Nothing to link to; send them to sign
            // in rather than silently creating a second account.
            return c.redirect("/login?error=session_expired");
          }
          const linked = await linkIdentityToUser(deps.db, sessionUser.id, identity);
          if (!linked.ok) {
            return c.redirect(`/settings?error=${linked.reason}`);
          }
          // Attach the Entra tokens to the CURRENT session — this is what the
          // /api/azure/* routes read. No new session, no new account.
          await attachEntraTokensToSession(deps.db, deps.cipher, sid, tokens);
          deps.sessionCache?.invalidate(sid);
          return c.redirect("/settings?linked=azure");
        }

        const user = await upsertUserByIdentity(deps.db, identity);
        const { sessionId, expiresAt } = await createEntraSession(
          deps.db,
          deps.cipher,
          user.id,
          tokens,
          deps.ttlDays,
        );
        setCookie(c, deps.cookieName, sessionId, {
          httpOnly: true,
          secure: deps.publicBaseUrl.startsWith("https://"),
          sameSite: "Lax",
          path: "/",
          expires: expiresAt,
        });
        return c.redirect(REDIRECT_AFTER_LOGIN);
      } catch (err) {
        console.error("[auth] entra callback error", err);
        return c.redirect(failRedirect);
      }
    });
  }

  r.post("/auth/logout", async (c) => {
    const sid = getCookie(c, deps.cookieName);
    if (sid) {
      await destroySession(deps.db, sid);
      // Drop the cached identity so the (now-deleted) session can't be served
      // from cache for up to the TTL after the user logs out.
      deps.sessionCache?.invalidate(sid);
      deleteCookie(c, deps.cookieName, { path: "/" });
    }
    return c.body(null, 204);
  });

  r.get("/api/me", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    // `identities` drives the settings page's linked-accounts section. Cheap
    // (one indexed read) and only on an endpoint the SPA already calls once.
    const identities = await listUserIdentities(deps.db, user.id);
    return c.json({ user, identities });
  });

  /**
   * Detach a linked identity.
   *
   * Refuses while the user still has Azure DevOps connections rather than
   * cascading: deleting a connection cascade-deletes its projects, and that is
   * far too destructive to hide behind an "unlink" button. Removing the Azure
   * projects first is the explicit path.
   */
  r.delete("/api/auth/identities/:provider", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    const provider = c.req.param("provider");
    if (provider !== "github" && provider !== "entra") {
      return c.json({ error: "unknown provider" }, 400);
    }

    if (provider === "entra") {
      const connections = await deps.db.query.azureDevopsConnections.findMany({
        where: eq(azureDevopsConnections.addedByUserId, user.id),
      });
      if (connections.length > 0) {
        return c.json(
          {
            error: `still connected to ${connections.length} Azure DevOps organization(s). Remove those projects first — unlinking would delete them.`,
            code: "connections_exist",
            organizations: connections.map((x) => x.orgName),
          },
          409,
        );
      }
    }

    const result = await unlinkIdentity(deps.db, user.id, provider);
    if (!result.ok) {
      const status = result.reason === "not_linked" ? 404 : 409;
      const message =
        result.reason === "last_identity"
          ? "this is the only way to sign in to this account; link another provider first"
          : "not linked";
      return c.json({ error: message, code: result.reason }, status);
    }

    if (provider === "entra") {
      // Drop the credentials too, so the session can't keep calling Azure with
      // an identity it no longer claims.
      const sid = getCookie(c, deps.cookieName);
      if (sid) {
        await clearEntraTokensFromSession(deps.db, sid);
        deps.sessionCache?.invalidate(sid);
      }
    }
    return c.body(null, 204);
  });

  // Which sign-in buttons the login page should render. Unauthenticated by
  // design — it leaks only which providers this deployment has configured,
  // which the login page reveals anyway.
  r.get("/api/auth/providers", (c) =>
    c.json({ providers: { github: !!deps.oauth, entra: !!deps.entraOAuth } }),
  );

  // Helper: throwaway log for an unused identifier so the bundler keeps imports.
  void githubInstallations;
  void ulid;
  void eq;
  return r;
}
