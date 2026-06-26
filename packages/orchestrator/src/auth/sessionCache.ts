import type { SessionRecord, UserRecord } from "./session.js";

export type LoadedSession = { session: SessionRecord; user: UserRecord } | null;

interface CacheEntry {
  value: LoadedSession;
  expiresAt: number;
}

/**
 * Coalesces and briefly caches session lookups so the auth middleware stops
 * being a DB-pool amplifier.
 *
 * Two problems this solves (both seen on opencara.com — OpenCara#146/#173,
 * which turned the resulting pool starvation into 524s and then fast 503s):
 *   1. Fan-out. Opening a project board fires ~10 authenticated API requests at
 *      once (kanban, kanban/stream, issues, the project, several issues, chat
 *      sessions, /api/me). Each independently ran loadSession() — ~10 pooled DB
 *      lookups for the SAME session in one page load. Single-flight collapses
 *      concurrent lookups for one sid into ONE in-flight DB read; the rest await
 *      that promise. A single board open now costs 1 lookup, not ~10.
 *   2. Repeat traffic. SSE reconnects, polling and navigation re-read identity
 *      constantly. A short TTL serves the cached record without touching the
 *      pool at all.
 *
 * Under sustained pool starvation single-flight also bounds the "zombie lookup"
 * blast radius described in middleware.withTimeout: N concurrent requests share
 * one background loadSession() instead of each leaving its own, so a starved
 * pool sees one queued acquire per sid rather than one per request.
 *
 * The TTL is deliberately tiny (seconds). Identity (login/avatar/expiry) changes
 * are rare and a few seconds of staleness is harmless; logout invalidates the
 * entry eagerly. GitHub *token* reads (getFreshUserToken / getDecryptedAccessToken)
 * bypass this cache and read the session row directly, so token rotation is never
 * served stale.
 */
export class SessionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<LoadedSession>>();
  private lastSweep: number;

  constructor(
    private readonly loader: (sid: string) => Promise<LoadedSession>,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {
    this.lastSweep = now();
  }

  get(sid: string): Promise<LoadedSession> {
    const t = this.now();
    const cached = this.entries.get(sid);
    if (cached && cached.expiresAt > t) return Promise.resolve(cached.value);

    // Single-flight: a lookup for this sid is already running — share it rather
    // than issuing a second DB round-trip (and a second pool acquire).
    const existing = this.inflight.get(sid);
    if (existing) return existing;

    this.maybeSweep(t);

    const p = this.loader(sid).then(
      (value) => {
        this.entries.set(sid, { value, expiresAt: this.now() + this.ttlMs });
        this.inflight.delete(sid);
        return value;
      },
      (err) => {
        // Never cache a failed lookup — let the next request retry the DB.
        this.inflight.delete(sid);
        throw err;
      },
    );
    this.inflight.set(sid, p);
    return p;
  }

  invalidate(sid: string): void {
    this.entries.delete(sid);
    this.inflight.delete(sid);
  }

  /**
   * Drop expired entries at most once per TTL window so a flood of distinct
   * cookies (e.g. bots) can't grow the map without bound. Timer-free so it adds
   * no always-on work and stays trivial to unit-test with an injected clock.
   */
  private maybeSweep(t: number): void {
    if (t - this.lastSweep <= this.ttlMs) return;
    this.lastSweep = t;
    for (const [sid, entry] of this.entries) {
      if (entry.expiresAt <= t) this.entries.delete(sid);
    }
  }
}
