import type { MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { Db } from "../db/client.js";
import { loadSession, type SessionRecord, type UserRecord } from "./session.js";

export interface AuthEnv {
  Variables: {
    user?: UserRecord;
    session?: SessionRecord;
  };
}

// Only these surfaces need a server-side identity. The static SPA shell and
// its fingerprinted /assets/* bundles must render WITHOUT ever touching the DB.
// The 2026-06-24 524s (and OpenCara#146 before them): `currentUser` runs on
// `*`, so the document request for `/` did a 3-round-trip session lookup before
// any HTML was served — when the Postgres pool saturated, the page load sat in
// postgres-js's acquire queue until Cloudflare's ~100s cutoff fired a 524.
// Anonymous requests never hit this because the lookup is cookie-gated; logged-
// in users ate every stall. Gating the lookup to the API/auth/webhook surface
// decouples "can I render the page" from "is the DB healthy right now."
const AUTH_PATH_PREFIXES = ["/api/", "/auth/", "/webhooks/"] as const;

function needsSessionLookup(path: string): boolean {
  // Match both the exact base path (e.g. "/api") and any sub-path (e.g. "/api/me").
  // Without the exact-match check, a request to "/api" (no trailing slash) would
  // be treated as a static path and silently skip the session lookup.
  return AUTH_PATH_PREFIXES.some((p) => path === p.slice(0, -1) || path.startsWith(p));
}

// Fail fast instead of hanging on a starved pool. postgres-js queues query
// acquisitions with no upper bound when all `max` connections are busy, so a
// starved request would otherwise sit until Cloudflare 524s it. Racing the
// lookup against a short deadline turns a multi-second hang into a quick 503
// that the SPA / CDN can retry — a recoverable error beats a dead page.
// Read once per app construction (in currentUser) so it stays off the hot path.
// Override with AUTH_SESSION_TIMEOUT_MS.
function resolveLookupTimeoutMs(): number {
  const raw = process.env["AUTH_SESSION_TIMEOUT_MS"];
  const n = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 3000;
}

class SessionLookupTimeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  // NOTE: when the timeout fires, `p` continues running in the background
  // (postgres-js has no query cancellation). Under sustained pool starvation
  // each 503 response leaves a zombie loadSession() waiting for a slot — which
  // can delay recovery. Acceptable trade-off: the 503 fast-fail is still the
  // right call; a future follow-up could cap in-flight lookups with a semaphore.
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new SessionLookupTimeout()), ms);
    // Never let this watchdog timer hold the process open on its own.
    (timer as { unref?: () => void }).unref?.();
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export function currentUser(db: Db, cookieName: string): MiddlewareHandler<AuthEnv> {
  const timeoutMs = resolveLookupTimeoutMs();
  return async (c, next) => {
    const sid = getCookie(c, cookieName);
    if (sid && needsSessionLookup(c.req.path)) {
      let loaded: Awaited<ReturnType<typeof loadSession>>;
      try {
        loaded = await withTimeout(loadSession(db, sid), timeoutMs);
      } catch (err) {
        if (err instanceof SessionLookupTimeout) {
          console.error(
            `[auth] session lookup exceeded ${timeoutMs}ms (DB pool saturated?) for ${c.req.method} ${c.req.path}; returning 503`,
          );
          c.header("Retry-After", "2");
          return c.json({ error: "service unavailable" }, 503);
        }
        throw err;
      }
      if (loaded) {
        c.set("user", loaded.user);
        c.set("session", loaded.session);
      }
    }
    await next();
  };
}

export function requireUser(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (!c.get("user")) {
      return c.json({ error: "unauthenticated" }, 401);
    }
    await next();
  };
}

export function requireXrwHeader(): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    if (c.req.method !== "GET" && c.req.method !== "HEAD") {
      const xrw = c.req.header("x-requested-with");
      if (xrw !== "fetch") {
        return c.json({ error: "missing X-Requested-With header" }, 400);
      }
    }
    await next();
  };
}
