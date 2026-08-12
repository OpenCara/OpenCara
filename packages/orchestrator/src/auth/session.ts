import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { ulid } from "ulid";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { sessions, userIdentities, users } from "../db/schema.js";
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
  /**
   * Null for a user who signed in with Microsoft Entra and has never linked a
   * GitHub account. Read `displayLogin()` rather than these when you just need
   * something to show.
   */
  githubUserId: number | null;
  githubLogin: string | null;
  name: string | null;
  avatarUrl: string | null;
  email: string | null;
}

/**
 * Best available human-readable handle for a user, across sign-in providers.
 * Falls back through GitHub login → display name → email local-part → a stable
 * short id, so callers never have to render an empty string.
 */
export function displayLogin(user: {
  id: string;
  githubLogin?: string | null;
  name?: string | null;
  email?: string | null;
}): string {
  if (user.githubLogin) return user.githubLogin;
  if (user.name) return user.name;
  const local = user.email?.split("@")[0];
  if (local) return local;
  return `user-${user.id.slice(-6)}`;
}

/** Identity providers a user can sign in with. */
export type IdentityProvider = "github" | "entra";

export interface ExternalIdentity {
  provider: IdentityProvider;
  /** Provider-native stable id: GitHub's numeric user id, Entra's `oid`. */
  externalId: string;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
  /**
   * GitHub only. Mirrored onto `users.github_user_id` / `github_login`, which
   * several display paths still read directly.
   */
  githubUserId?: number;
}

/**
 * Find-or-create the account behind an external identity.
 *
 * Lookup is by (provider, externalId) against `user_identities`, NOT by the
 * legacy `users.github_user_id`, so a user with no GitHub account can exist.
 * Emails are deliberately NOT used to match across providers — auto-linking on
 * a self-asserted email is a well-known account-takeover vector, so signing in
 * with Entra using the same address as an existing GitHub account creates a
 * separate account. Linking is an explicit action from an authenticated
 * session.
 */
export async function upsertUserByIdentity(
  db: Db,
  identity: ExternalIdentity,
): Promise<UserRecord> {
  const now = new Date();
  const existingIdentity = await db.query.userIdentities.findFirst({
    where: and(
      eq(userIdentities.provider, identity.provider),
      eq(userIdentities.externalId, identity.externalId),
    ),
  });

  // Fields that mirror onto `users` for the display paths. Only overwrite the
  // GitHub cache from a GitHub sign-in — an Entra sign-in must not blank out a
  // linked GitHub login.
  const userPatch = {
    name: identity.name,
    avatarUrl: identity.avatarUrl,
    email: identity.email,
    updatedAt: now,
    ...(identity.provider === "github"
      ? { githubUserId: identity.githubUserId ?? null, githubLogin: identity.login }
      : {}),
  };

  if (existingIdentity) {
    await db
      .update(users)
      .set(userPatch)
      .where(eq(users.id, existingIdentity.userId));
    await db
      .update(userIdentities)
      .set({ login: identity.login, updatedAt: now })
      .where(eq(userIdentities.id, existingIdentity.id));
    const row = await db.query.users.findFirst({
      where: eq(users.id, existingIdentity.userId),
    });
    return toUserRecord(existingIdentity.userId, row, identity);
  }

  const id = ulid();
  await db.insert(users).values({
    id,
    githubUserId: identity.provider === "github" ? (identity.githubUserId ?? null) : null,
    githubLogin: identity.provider === "github" ? identity.login : null,
    name: identity.name,
    avatarUrl: identity.avatarUrl,
    email: identity.email,
  });
  await db.insert(userIdentities).values({
    id: ulid(),
    userId: id,
    provider: identity.provider,
    externalId: identity.externalId,
    login: identity.login,
  });
  return toUserRecord(id, undefined, identity);
}

function toUserRecord(
  id: string,
  row: { githubUserId: number | null; githubLogin: string | null } | undefined,
  identity: ExternalIdentity,
): UserRecord {
  const isGithub = identity.provider === "github";
  return {
    id,
    githubUserId: isGithub ? (identity.githubUserId ?? null) : (row?.githubUserId ?? null),
    githubLogin: isGithub ? identity.login : (row?.githubLogin ?? null),
    name: identity.name,
    avatarUrl: identity.avatarUrl,
    email: identity.email,
  };
}

/** GitHub sign-in entry point. Thin adapter over `upsertUserByIdentity`. */
export async function upsertUser(db: Db, viewer: ViewerProfile): Promise<UserRecord> {
  return upsertUserByIdentity(db, {
    provider: "github",
    externalId: String(viewer.id),
    githubUserId: viewer.id,
    login: viewer.login,
    name: viewer.name,
    email: viewer.email,
    avatarUrl: viewer.avatarUrl,
  });
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
    authProvider: "github",
    githubAccessTokenEnc: cipher.encrypt(tokens.accessToken),
    githubRefreshTokenEnc: tokens.refreshToken ? cipher.encrypt(tokens.refreshToken) : null,
    githubTokenExpiresAt: tokens.expiresAt ?? null,
    expiresAt,
  });
  return { sessionId, expiresAt };
}

/**
 * Session for a user who authenticated with Microsoft Entra.
 *
 * The stored Entra tokens are the *user's* — used to enumerate the Azure DevOps
 * organizations they may connect. Once an organization is connected, its own
 * row on `azure_devops_connections` holds the credentials that drive repo and
 * PR traffic, so this session token is not on the hot path.
 */
export async function createEntraSession(
  db: Db,
  cipher: TokenCipher,
  userId: string,
  tokens: { accessToken: string; refreshToken?: string | undefined; expiresAt: Date },
  ttlDays: number,
): Promise<{ sessionId: string; expiresAt: Date }> {
  const sessionId = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);
  await db.insert(sessions).values({
    id: sessionId,
    userId,
    authProvider: "entra",
    entraAccessTokenEnc: cipher.encrypt(tokens.accessToken),
    entraRefreshTokenEnc: tokens.refreshToken ? cipher.encrypt(tokens.refreshToken) : null,
    entraTokenExpiresAt: tokens.expiresAt,
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
  // Entra-authenticated sessions hold no GitHub token. Callers already handle
  // null as "no user token available" and degrade to installation auth.
  if (!row.githubAccessTokenEnc) return null;
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
  // Entra-authenticated session: no GitHub token to freshen. Same contract as a
  // session miss — the caller falls back to installation auth or 401s.
  if (!row.githubAccessTokenEnc) return null;
  const accessTokenEnc = row.githubAccessTokenEnc;
  const now = Date.now();
  const exp = row.githubTokenExpiresAt?.getTime();
  if (exp && exp - REFRESH_SKEW_MS > now) {
    return cipher.decrypt(accessTokenEnc);
  }
  // Past skew OR no expiry recorded. The no-expiry case can happen for
  // legacy sessions written before user-token refresh was wired up — treat
  // them as "refresh if we can," fall back to the stored token if we can't.
  if (!row.githubRefreshTokenEnc) {
    return exp && exp <= now ? null : cipher.decrypt(accessTokenEnc);
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
