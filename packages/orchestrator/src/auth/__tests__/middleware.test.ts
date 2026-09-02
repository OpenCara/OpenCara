import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { currentUser, type AuthEnv } from "../middleware.js";
import type { Db } from "../../db/client.js";

// A Db stand-in that records whether the session lookup touched the DB at all,
// and can be made to hang to exercise the fast-fail path. Only the surface
// loadSession() reaches is implemented.
function fakeDb(opts: {
  hangMs?: number;
  session?: { id: string; userId: string; expiresAt: Date; lastSeenAt: Date } | null;
  user?: { id: string } | null;
}): { db: Db; calls: () => number } {
  let calls = 0;
  const sessionRow = opts.session ?? null;
  const userRow = opts.user ?? null;
  const maybeHang = <T>(value: T): Promise<T> =>
    opts.hangMs
      ? new Promise<T>((resolve) => setTimeout(() => resolve(value), opts.hangMs))
      : Promise.resolve(value);
  const db = {
    query: {
      sessions: {
        findFirst: () => {
          calls++;
          return maybeHang(sessionRow);
        },
      },
      users: {
        findFirst: () => {
          calls++;
          return maybeHang(userRow);
        },
      },
    },
    // loadSession only ever reaches update() when lastSeenAt is stale; the
    // tests below keep it fresh, so this should never be called — fail loudly
    // if it is.
    update: () => {
      throw new Error("unexpected db.update in test");
    },
  } as unknown as Db;
  return { db, calls: () => calls };
}

function appWith(db: Db): Hono<AuthEnv> {
  const app = new Hono<AuthEnv>();
  app.use("*", currentUser(db, "sid"));
  app.get("/*", (c) => c.text(c.get("user") ? "user" : "anon"));
  return app;
}

describe("currentUser middleware", () => {
  it("does NOT touch the DB for static/SPA paths even with a session cookie", async () => {
    const { db, calls } = fakeDb({ session: null });
    const res = await appWith(db).request("/", { headers: { cookie: "sid=abc" } });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "anon");
    assert.equal(calls(), 0, "session lookup must be skipped on non-auth paths");
  });

  it("does NOT touch the DB for /assets/* bundles", async () => {
    const { db, calls } = fakeDb({ session: null });
    const res = await appWith(db).request("/assets/index-abc.js", {
      headers: { cookie: "sid=abc" },
    });
    assert.equal(calls(), 0);
    assert.equal(res.status, 200);
  });

  it("performs the session lookup for /api/* paths", async () => {
    const now = new Date();
    const { db, calls } = fakeDb({
      session: { id: "abc", userId: "u1", expiresAt: new Date(now.getTime() + 1e6), lastSeenAt: now },
      user: { id: "u1" },
    });
    const app = new Hono<AuthEnv>();
    app.use("*", currentUser(db, "sid"));
    app.get("/api/me", (c) => c.json({ user: c.get("user") ?? null }));
    const res = await app.request("/api/me", { headers: { cookie: "sid=abc" } });
    assert.equal(res.status, 200);
    assert.ok(calls() >= 1, "session lookup must run on /api paths");
  });

  it("skips the lookup entirely when there is no session cookie", async () => {
    const { db, calls } = fakeDb({ session: null });
    const res = await appWith(db).request("/api/me");
    assert.equal(calls(), 0);
    assert.equal(res.status, 200);
  });

  it("coalesces concurrent same-cookie lookups into a single DB read (fan-out fix)", async () => {
    const now = new Date();
    // Hang each query briefly so the 10 requests overlap in-flight; without
    // single-flight that would be 10 loadSession()s (= 20 findFirst calls).
    const { db, calls } = fakeDb({
      hangMs: 30,
      session: { id: "abc", userId: "u1", expiresAt: new Date(now.getTime() + 1e6), lastSeenAt: now },
      user: { id: "u1" },
    });
    const app = new Hono<AuthEnv>();
    app.use("*", currentUser(db, "sid"));
    app.get("/api/me", (c) => c.json({ user: c.get("user") ?? null }));

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        app.request("/api/me", { headers: { cookie: "sid=abc" } }),
      ),
    );
    for (const res of results) assert.equal(res.status, 200);
    // One loadSession() = sessions.findFirst + users.findFirst = 2 calls, shared
    // across all 10 concurrent requests.
    assert.equal(calls(), 2, "10 concurrent requests must share one session lookup");
  });

  it("serves a cached identity on a second request without re-reading the DB", async () => {
    const now = new Date();
    const { db, calls } = fakeDb({
      session: { id: "abc", userId: "u1", expiresAt: new Date(now.getTime() + 1e6), lastSeenAt: now },
      user: { id: "u1" },
    });
    const app = new Hono<AuthEnv>();
    app.use("*", currentUser(db, "sid"));
    app.get("/api/me", (c) => c.json({ user: c.get("user") ?? null }));

    await app.request("/api/me", { headers: { cookie: "sid=abc" } });
    await app.request("/api/me", { headers: { cookie: "sid=abc" } });
    assert.equal(calls(), 2, "second request within TTL must be served from cache");
  });

  it("returns 503 (not a hang) when the session lookup exceeds the deadline", async () => {
    // currentUser() reads the timeout once at construction, so set it first.
    process.env["AUTH_SESSION_TIMEOUT_MS"] = "50";
    try {
      const { db } = fakeDb({ hangMs: 1000, session: null });
      const app = new Hono<AuthEnv>();
      app.use("*", currentUser(db, "sid"));
      app.get("/api/me", (c) => c.text("ok"));
      const started = Date.now();
      const res = await app.request("/api/me", { headers: { cookie: "sid=abc" } });
      const elapsed = Date.now() - started;
      assert.equal(res.status, 503);
      assert.equal(res.headers.get("retry-after"), "2");
      assert.ok(elapsed < 500, `should fail fast, took ${elapsed}ms`);
    } finally {
      delete process.env["AUTH_SESSION_TIMEOUT_MS"];
    }
  });
});
