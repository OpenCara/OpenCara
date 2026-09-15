import type { SessionRecord, UserRecord } from "./session.js";

export type LoadedSession = { session: SessionRecord; user: UserRecord } | null;

interface CacheEntry {
  value: LoadedSession;
  /** Fresh until this instant — served without any DB work. */
  expiresAt: number;
  /**
   * Stale-while-revalidate window end: past expiresAt but before
   * staleUntil, the entry is still served while a background refresh is
   * kicked off. Past staleUntil the entry is dropped and the request goes
   * through the normal blocking load.
   */
  staleUntil: number;
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
 * Stale-while-revalidate (OpenCara#245): an entry that expires MID-BURST used
 * to drop straight onto the starved pool — the next request either queued past
 * the 3s middleware deadline (503) or, worse, many sids expiring together
 * multiplied the queue. Now an expired-but-recent entry is served immediately
 * while exactly one background refresh runs; the request never touches the
 * pool during the window. Staleness is bounded by `staleMs` and by an explicit
 * check that the cached record's own session.expiresAt hasn't passed — a
 * session that aged past its real expiry is never resurrected from cache.
 * Logout still invalidates eagerly, and GitHub *token* reads
 * (getFreshUserToken / getDecryptedAccessToken) bypass this cache entirely.
 */
export class SessionCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly inflight = new Map<string, Promise<LoadedSession>>();
  private lastSweep: number;

  constructor(
    private readonly loader: (sid: string) => Promise<LoadedSession>,
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
    private readonly staleMs: number = 30_000,
  ) {
    this.lastSweep = now();
  }

  get(sid: string): Promise<LoadedSession> {
    const t = this.now();
    const cached = this.entries.get(sid);
    if (cached) {
      if (cached.expiresAt > t) return Promise.resolve(cached.value);
      if (cached.staleUntil > t && !this.isSessionExpired(cached.value, t)) {
        // Serve stale + refresh in the background: the request never
        // waits on the pool during a burst, and exactly one DB read runs
        // per sid (single-flight on the revalidation).
        this.revalidate(sid);
        return Promise.resolve(cached.value);
      }
      this.entries.delete(sid);
    }

    // Single-flight: a lookup for this sid is already running — share it rather
    // than issuing a second DB round-trip (and a second pool acquire).
    const existing = this.inflight.get(sid);
    if (existing) return existing;

    this.maybeSweep(t);
    return this.startLoad(sid);
  }

  invalidate(sid: string): void {
    this.entries.delete(sid);
    this.inflight.delete(sid);
  }

  /**
   * A cached record whose session.expiresAt has already passed must not be
   * served stale — that would resurrect an expired session for the whole
   * stale window. Fall through to a real lookup (which deletes the row and
   * returns null, or 503s while the DB is starved — both correct).
   */
  private isSessionExpired(value: LoadedSession, t: number): boolean {
    return value !== null && value.session.expiresAt.getTime() <= t;
  }

  private startLoad(sid: string): Promise<LoadedSession> {
    const p = this.loader(sid).then(
      (value) => {
        const t = this.now();
        this.entries.set(sid, {
          value,
          expiresAt: t + this.ttlMs,
          staleUntil: t + this.ttlMs + this.staleMs,
        });
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

  /**
   * Fire a single-flight refresh without a waiter. The rejection is absorbed
   * here — the stale entry keeps serving until the refresh lands or the stale
   * window closes, and an unhandled rejection would just be noise.
   */
  private revalidate(sid: string): void {
    if (this.inflight.has(sid)) return;
    this.startLoad(sid).catch(() => undefined);
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
      if (entry.staleUntil <= t) this.entries.delete(sid);
    }
  }
}
