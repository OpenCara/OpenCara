import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SessionCache, type LoadedSession } from "../sessionCache.js";

// A loaded-session stand-in. Only identity (the sid carried through userId) is
// asserted, so the rest is filler.
function loaded(sid: string): LoadedSession {
  const now = new Date();
  return {
    session: { id: sid, userId: `u-${sid}`, expiresAt: new Date(now.getTime() + 1e6) },
    user: {
      id: `u-${sid}`,
      githubUserId: 1,
      githubLogin: "octocat",
      name: null,
      avatarUrl: null,
      email: null,
    },
  };
}

// Manual clock so TTL behaviour is deterministic without real timers.
function fakeClock(start = 1000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

// A loader that counts invocations and can be made to hang until released, to
// exercise the single-flight path.
function countingLoader() {
  let calls = 0;
  return {
    calls: () => calls,
    loader: (sid: string): Promise<LoadedSession> => {
      calls++;
      return Promise.resolve(loaded(sid));
    },
  };
}

describe("SessionCache", () => {
  it("coalesces concurrent lookups for the same sid into one DB read", async () => {
    let resolve!: (v: LoadedSession) => void;
    let calls = 0;
    const loader = (_sid: string): Promise<LoadedSession> => {
      calls++;
      return new Promise<LoadedSession>((r) => {
        resolve = r;
      });
    };
    const clock = fakeClock();
    const cache = new SessionCache(loader, 10_000, clock.now);

    // Fire 10 concurrent gets while the loader is still in-flight.
    const inflight = Array.from({ length: 10 }, () => cache.get("abc"));
    assert.equal(calls, 1, "single-flight: only one loader call for 10 concurrent gets");

    resolve(loaded("abc"));
    const results = await Promise.all(inflight);
    for (const r of results) assert.equal(r?.user.id, "u-abc");
  });

  it("serves a cached identity within the TTL without re-reading the DB", async () => {
    const { loader, calls } = countingLoader();
    const clock = fakeClock();
    const cache = new SessionCache(loader, 10_000, clock.now);

    assert.equal((await cache.get("abc"))?.user.id, "u-abc");
    assert.equal(calls(), 1);

    clock.advance(5_000); // still within TTL
    assert.equal((await cache.get("abc"))?.user.id, "u-abc");
    assert.equal(calls(), 1, "second get within TTL must not touch the DB");
  });

  it("re-reads the DB once the TTL has elapsed", async () => {
    const { loader, calls } = countingLoader();
    const clock = fakeClock();
    const cache = new SessionCache(loader, 10_000, clock.now);

    await cache.get("abc");
    clock.advance(10_001); // just past TTL
    await cache.get("abc");
    assert.equal(calls(), 2, "expired entry must trigger a fresh lookup");
  });

  it("a zero TTL keeps single-flight but disables caching", async () => {
    const { loader, calls } = countingLoader();
    const clock = fakeClock();
    const cache = new SessionCache(loader, 0, clock.now);

    await cache.get("abc");
    await cache.get("abc"); // not concurrent → no cache → fresh lookup
    assert.equal(calls(), 2);
  });

  it("invalidate() drops the cached entry so the next get re-reads", async () => {
    const { loader, calls } = countingLoader();
    const clock = fakeClock();
    const cache = new SessionCache(loader, 10_000, clock.now);

    await cache.get("abc");
    assert.equal(calls(), 1);
    cache.invalidate("abc");
    await cache.get("abc");
    assert.equal(calls(), 2, "invalidated sid must be re-read even within TTL");
  });

  it("never caches a failed lookup", async () => {
    let calls = 0;
    let shouldThrow = true;
    const loader = (sid: string): Promise<LoadedSession> => {
      calls++;
      if (shouldThrow) return Promise.reject(new Error("pool starved"));
      return Promise.resolve(loaded(sid));
    };
    const clock = fakeClock();
    const cache = new SessionCache(loader, 10_000, clock.now);

    await assert.rejects(cache.get("abc"), /pool starved/);
    shouldThrow = false;
    // Within TTL, but the rejection must not have been cached.
    assert.equal((await cache.get("abc"))?.user.id, "u-abc");
    assert.equal(calls, 2);
  });

  it("keeps distinct sids independent", async () => {
    const { loader, calls } = countingLoader();
    const clock = fakeClock();
    const cache = new SessionCache(loader, 10_000, clock.now);

    assert.equal((await cache.get("a"))?.user.id, "u-a");
    assert.equal((await cache.get("b"))?.user.id, "u-b");
    assert.equal(calls(), 2);
  });
});
