import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { randomBytes } from "node:crypto";
import { ulid } from "ulid";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { githubInstallations } from "../db/schema.js";
import type { GithubOAuth } from "../github/oauth.js";
import type { GithubAppClient } from "../github/app.js";
import { upsertUser, createSession, destroySession, type TokenCipher } from "../auth/session.js";
import type { AuthEnv } from "../auth/middleware.js";
import type { SessionCache } from "../auth/sessionCache.js";
import { upsertInstallation } from "../github/installations.js";

interface AuthRouteDeps {
  db: Db;
  oauth: GithubOAuth;
  cipher: TokenCipher;
  cookieName: string;
  ttlDays: number;
  publicBaseUrl: string;
  app?: GithubAppClient;
  sessionCache?: SessionCache;
}

const STATE_COOKIE = "ocara_oauth_state";
const STATE_TTL_SEC = 60 * 5;
const REDIRECT_AFTER_LOGIN = "/";

export function authRoutes(deps: AuthRouteDeps) {
  const r = new Hono<AuthEnv>();

  r.get("/auth/github/login", (c) => {
    const state = randomBytes(16).toString("base64url");
    setCookie(c, STATE_COOKIE, state, {
      httpOnly: true,
      secure: deps.publicBaseUrl.startsWith("https://"),
      sameSite: "Lax",
      path: "/",
      maxAge: STATE_TTL_SEC,
    });
    return c.redirect(deps.oauth.buildAuthorizeUrl(state));
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
      const tokens = await deps.oauth.exchangeCode(code);
      const viewer = await deps.oauth.getViewer(tokens.accessToken);
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

  r.get("/api/me", (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "unauthenticated" }, 401);
    return c.json({ user });
  });

  // Helper: throwaway log for an unused identifier so the bundler keeps imports.
  void githubInstallations;
  void ulid;
  void eq;
  return r;
}
