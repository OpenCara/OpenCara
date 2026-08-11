import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { azureDevopsConnections } from "../db/schema.js";
import type { TokenCipher } from "../auth/session.js";
import type { EntraOAuth } from "./entra.js";

/**
 * Azure DevOps REST client bound to one connected organization.
 *
 * Two things it owns that callers should not reimplement:
 *
 *  1. **Token freshness.** Entra access tokens last ~1h. `accessToken()`
 *     refreshes through the stored refresh token and persists the rotated pair
 *     back to the connection row, so a long-lived orchestrator does not
 *     accumulate dead connections.
 *  2. **api-version.** Every Azure DevOps endpoint requires an explicit
 *     `api-version` query parameter and silently behaves differently without
 *     the right one. It is applied centrally here.
 */

/** Pinned rather than "latest" so a service-side default change can't silently alter response shapes. */
export const AZDO_API_VERSION = "7.1";

/** Refresh this far before actual expiry to avoid a token dying mid-request. */
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export type AzureDevopsConnectionRow = typeof azureDevopsConnections.$inferSelect;

export interface AzureDevopsClientDeps {
  db: Db;
  cipher: TokenCipher;
  entra: EntraOAuth;
}

export class AzureDevopsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly url: string,
  ) {
    super(message);
    this.name = "AzureDevopsApiError";
  }
}

/**
 * Thrown when a connection's refresh token is gone or rejected. Distinct from a
 * transient API error because the fix is different: the user must reconnect the
 * organization, and no amount of retrying helps.
 */
export class AzureDevopsAuthError extends Error {
  constructor(
    message: string,
    readonly connectionId: string,
  ) {
    super(message);
    this.name = "AzureDevopsAuthError";
  }
}

export class AzureDevopsClient {
  constructor(
    private deps: AzureDevopsClientDeps,
    private connection: AzureDevopsConnectionRow,
  ) {}

  get orgName(): string {
    return this.connection.orgName;
  }

  get connectionId(): string {
    return this.connection.id;
  }

  /** Base for organization-level endpoints. */
  get orgUrl(): string {
    return `https://dev.azure.com/${encodeURIComponent(this.connection.orgName)}`;
  }

  /**
   * A valid access token, refreshed if it is at or near expiry. Also used to
   * furnish agent runs with a credential — note that unlike a GitHub
   * installation token this is user-delegated, cannot be scoped to a subset of
   * repositories, and cannot be revoked early.
   */
  async accessToken(): Promise<string> {
    const { accessTokenEnc, accessTokenExpiresAt, refreshTokenEnc } = this.connection;
    const stillFresh =
      accessTokenEnc &&
      accessTokenExpiresAt &&
      accessTokenExpiresAt.getTime() - REFRESH_SKEW_MS > Date.now();
    if (stillFresh) return this.deps.cipher.decrypt(accessTokenEnc);

    if (!refreshTokenEnc) {
      throw new AzureDevopsAuthError(
        `Azure DevOps connection '${this.connection.orgName}' has no refresh token — reconnect the organization`,
        this.connection.id,
      );
    }

    let tokens;
    try {
      tokens = await this.deps.entra.refresh(this.deps.cipher.decrypt(refreshTokenEnc));
    } catch (err) {
      // A refused refresh means consent was revoked, the password changed, or
      // the token aged out. All need a human, so say so plainly.
      throw new AzureDevopsAuthError(
        `Azure DevOps connection '${this.connection.orgName}' could not refresh its token (${
          err instanceof Error ? err.message : String(err)
        }) — reconnect the organization`,
        this.connection.id,
      );
    }

    const patch = {
      accessTokenEnc: this.deps.cipher.encrypt(tokens.accessToken),
      accessTokenExpiresAt: tokens.expiresAt,
      // Entra rotates refresh tokens; keeping the old one would break the next
      // refresh once the rotated one supersedes it.
      ...(tokens.refreshToken
        ? { refreshTokenEnc: this.deps.cipher.encrypt(tokens.refreshToken) }
        : {}),
      updatedAt: new Date(),
    };
    await this.deps.db
      .update(azureDevopsConnections)
      .set(patch)
      .where(eq(azureDevopsConnections.id, this.connection.id));
    // Keep the in-memory row in step so repeated calls on this instance don't
    // each trigger a refresh.
    this.connection = { ...this.connection, ...patch };
    return tokens.accessToken;
  }

  /**
   * Issue a request against an absolute Azure DevOps URL.
   *
   * `apiVersion` is appended unless the caller already set one. Returns parsed
   * JSON; throws AzureDevopsApiError on a non-2xx with the response body
   * included, because Azure DevOps puts the actionable detail in `message`.
   */
  async request<T = unknown>(
    url: string,
    init: { method?: string; body?: unknown; apiVersion?: string } = {},
  ): Promise<T> {
    const token = await this.accessToken();
    const target = new URL(url);
    if (!target.searchParams.has("api-version")) {
      target.searchParams.set("api-version", init.apiVersion ?? AZDO_API_VERSION);
    }
    const res = await fetch(target.toString(), {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        accept: "application/json",
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });

    const text = await res.text();
    if (!res.ok) {
      throw new AzureDevopsApiError(
        `azure devops ${init.method ?? "GET"} ${target.pathname} failed (${res.status}): ${extractMessage(text)}`,
        res.status,
        target.toString(),
      );
    }
    if (!text) return undefined as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      // A 200 with a non-JSON body means the request was silently redirected to
      // a sign-in page — the classic symptom of a token that lacks the Azure
      // DevOps resource scope. Say that rather than "unexpected token < in JSON".
      throw new AzureDevopsApiError(
        `azure devops ${target.pathname} returned a non-JSON body — the access token is probably missing the Azure DevOps scope`,
        res.status,
        target.toString(),
      );
    }
  }

  /** Convenience for organization-scoped paths, e.g. `_apis/git/repositories`. */
  async orgRequest<T = unknown>(
    path: string,
    init?: { method?: string; body?: unknown; apiVersion?: string },
  ): Promise<T> {
    return this.request<T>(`${this.orgUrl}/${path.replace(/^\//, "")}`, init);
  }
}

function extractMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string") return parsed.message;
  } catch {
    // not JSON — fall through
  }
  return text.slice(0, 500);
}

/** Load a connection and wrap it in a client. Returns null when it's gone. */
export async function clientForConnection(
  deps: AzureDevopsClientDeps,
  connectionId: string,
): Promise<AzureDevopsClient | null> {
  const row = await deps.db.query.azureDevopsConnections.findFirst({
    where: eq(azureDevopsConnections.id, connectionId),
  });
  return row ? new AzureDevopsClient(deps, row) : null;
}
