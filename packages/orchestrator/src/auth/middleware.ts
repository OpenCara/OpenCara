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

export function currentUser(db: Db, cookieName: string): MiddlewareHandler<AuthEnv> {
  return async (c, next) => {
    const sid = getCookie(c, cookieName);
    if (sid) {
      const loaded = await loadSession(db, sid);
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
