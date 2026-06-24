import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ulid } from "ulid";
import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessions, users } from "../db/schema.js";
import type { GithubOAuth, UserTokens, ViewerProfile } from "../github/oauth.js";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;

export class TokenCipher {
  private key: Buffer;
  constructor(hex32: string) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex32)) {
      throw new Error("SESSION_ENCRYPTION_KEY must be 64 hex chars (32 bytes)");
    }
    this.key = Buffer.from(hex32, "hex");
  }
  encrypt(plain: string): string {
    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([iv, tag, ct]).toString("base64");
  }
  decrypt(blob: string): string {
    const buf = Buffer.from(blob, "base64");
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const ct = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
  }
}

export interface SessionRecord {
  id: string;
  userId: string;
  expiresAt: Date;
}
export interface UserRecord {
  id: string;
  githubUserId: number;
  githubLogin: string;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
}

export async function upsertUser(db: Db, viewer: ViewerProfile): Promise<UserRecord> {
  const existing = await db.query.users.findFirst({
    where: eq(users.githubUserId, viewer.id),
  });
  if (existing) {
    await db
      .update(users)
      .set({
        githubLogin: viewer.login,
        name: viewer.name,
        avatarUrl: viewer.avatarUrl,
        email: viewer.email,
        updatedAt: new Date(),
      })
      .where(eq(users.id, existing.id));
    return {
      id: existing.id,
      githubUserId: viewer.id,
      githubLogin: viewer.login,
      name: viewer.name,
      avatarUrl: viewer.avatarUrl,
      email: viewer.email,
    };
  }
  const id = ulid();
  await db.insert(users).values({
    id,
    githubUserId: viewer.id,
    githubLogin: viewer.login,
    name: viewer.name,
    avatarUrl: viewer.avatarUrl,
    email: viewer.email,
  });
  return {
    id,
    githubUserId: viewer.id,
    githubLogin: viewer.login,
    name: viewer.name,
    avatarUrl: viewer.avatarUrl,
    email: viewer.email,
  };
}

export async function createSession(
  db: Db,
  cipher: TokenCipher,
  userId: string,
  tokens: UserTokens,
  ttlDays: number,
): Promise<{ sessionId: string; expiresAt: Date }> {
  const sessionId = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    githubAccessTokenEnc: cipher.encrypt(tokens.accessToken),
    githubRefreshTokenEnc: tokens.refreshToken ? cipher.encrypt(tokens.refreshToken) : null,
    githubTokenExpiresAt: tokens.expiresAt ?? null,
    expiresAt,
  });
  return { sessionId, expiresAt };
}

// `lastSeenAt` only powers coarse "active sessions" reporting, yet the original
// code wrote it on EVERY request — a third DB round-trip (a WRITE, contending
// for a scarce pooled connection) on the hottest path in the app. Two changes
// keep that cost off the request:
//   1. Throttle: skip the write unless lastSeenAt is already stale by this much.
//   2. Fire-and-forget: never `await` the bookkeeping write, so request latency
//      (and its pool slot) never depends on it completing.
const LAST_SEEN_THROTTLE_MS = 5 * 60 * 1000;

export async function loadSession(
  db: Db,
  sessionId: string,
): Promise<{ session: SessionRecord; user: UserRecord } | null> {
  const row = await db.query.sessions.findFirst({
    where: eq(sessions.id, sessionId),
  });
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) {
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    return null;
  }
  const u = await db.query.users.findFirst({ where: eq(users.id, row.userId) });
  if (!u) return null;
  if (Date.now() - row.lastSeenAt.getTime() > LAST_SEEN_THROTTLE_MS) {
    void db
      .update(sessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(sessions.id, sessionId))
      .catch((err: unknown) => {
        console.error("[auth] lastSeenAt update failed (non-fatal):", err);
      });
  }
  return {
    session: { id: row.id, userId: row.userId, expiresAt: row.expiresAt },
    user: {
      id: u.id,
      githubUserId: u.githubUserId,
      githubLogin: u.githubLogin,
      name: u.name,
      avatarUrl: u.avatarUrl,
      email: u.email,
    },
  };
}

export async function destroySession(db: Db, sessionId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sessionId));
}

export async function getDecryptedAccessToken(
  db: Db,
  cipher: TokenCipher,
  sessionId: string,
): Promise<string | null> {
  const row = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!row) return null;
  return cipher.decrypt(row.githubAccessTokenEnc);
}

// Refresh the GitHub user-to-server OAuth token if it's at or near expiry,
// persist the rotated tokens back to the session row, and return the live
// access token. Used by routes that need to make calls as the user (e.g.
// kanban discovery on user-owned Projects v2, which the App installation
// token cannot see). Returns null on session/user-token miss; throws if the
// refresh itself fails (caller surfaces a 401/502 — re-login is the fix).
//
// Skew: GitHub's user tokens last ~8h; refreshing a minute early keeps us
// out of the half-second race where we decide "still valid" then GitHub
// expires it mid-request.
const REFRESH_SKEW_MS = 60 * 1000;

export async function getFreshUserToken(
  db: Db,
  cipher: TokenCipher,
  oauth: GithubOAuth,
  sessionId: string,
): Promise<string | null> {
  const row = await db.query.sessions.findFirst({ where: eq(sessions.id, sessionId) });
  if (!row) return null;
  const now = Date.now();
  const exp = row.githubTokenExpiresAt?.getTime();
  if (exp && exp - REFRESH_SKEW_MS > now) {
    return cipher.decrypt(row.githubAccessTokenEnc);
  }
  // Past skew OR no expiry recorded. The no-expiry case can happen for
  // legacy sessions written before user-token refresh was wired up — treat
  // them as "refresh if we can," fall back to the stored token if we can't.
  if (!row.githubRefreshTokenEnc) {
    return exp && exp <= now ? null : cipher.decrypt(row.githubAccessTokenEnc);
  }
  const refresh = cipher.decrypt(row.githubRefreshTokenEnc);
  const next = await oauth.refreshUserToken(refresh);
  await db
    .update(sessions)
    .set({
      githubAccessTokenEnc: cipher.encrypt(next.accessToken),
      githubRefreshTokenEnc: next.refreshToken
        ? cipher.encrypt(next.refreshToken)
        : row.githubRefreshTokenEnc,
      githubTokenExpiresAt: next.expiresAt ?? null,
    })
    .where(eq(sessions.id, sessionId));
  return next.accessToken;
}
