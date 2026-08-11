import { z } from "zod";

/**
 * Microsoft Entra ID OAuth 2.0 client, scoped to what OpenCara needs: sign a
 * user in, and obtain tokens that can call the Azure DevOps REST API on their
 * behalf.
 *
 * Deliberately hand-rolled against the v2.0 endpoints rather than pulling in
 * MSAL. The confidential-client authorization-code flow is three HTTP calls,
 * and MSAL's value is mostly in token caching and broker integration that a
 * server storing its own encrypted refresh tokens does not use.
 *
 * ## The Azure DevOps resource scope
 *
 * `499b84ac-1321-427f-aa17-267ca6975798` is the fixed, well-known application
 * id of the Azure DevOps resource in every Entra tenant — it is not
 * deployment-specific and does not need configuring. Requesting
 * `<that>/.default` asks for whatever Azure DevOps delegated permissions the
 * app registration was granted, which is how least privilege is expressed here:
 * narrow the registration, not this string.
 *
 * ## What these tokens can do
 *
 * They are USER-DELEGATED. Unlike a GitHub App installation token there is no
 * per-repository scoping and no revocation endpoint — an access token is valid
 * until it expires (~1h). Anything handed one can act as the connecting user
 * across every organization they can reach.
 */

/** Well-known Azure DevOps resource app id — same in every Entra tenant. */
export const AZURE_DEVOPS_RESOURCE_ID = "499b84ac-1321-427f-aa17-267ca6975798";

/**
 * `offline_access` is what makes a refresh token come back; without it the
 * connection dies an hour after it is made. `openid profile email` populate the
 * id token claims used for sign-in.
 */
export const ENTRA_SCOPES = [
  "openid",
  "profile",
  "email",
  "offline_access",
  `${AZURE_DEVOPS_RESOURCE_ID}/.default`,
].join(" ");

export interface EntraConfig {
  clientId: string;
  clientSecret: string;
  /** "common", "organizations", or a tenant GUID. */
  tenant: string;
  publicBaseUrl: string;
}

export interface EntraTokens {
  accessToken: string;
  refreshToken?: string | undefined;
  expiresAt: Date;
  /** Raw id token, present on the initial sign-in exchange. */
  idToken?: string | undefined;
}

export interface EntraProfile {
  /** `oid` claim — stable per user per tenant. The identity key. */
  objectId: string;
  tenantId: string;
  /** userPrincipalName / preferred_username, e.g. someone@contoso.com. */
  login: string;
  name: string | null;
  email: string | null;
}

const TokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  id_token: z.string().optional(),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

/**
 * Entra returns errors as a 400 with a JSON body whose `error_description`
 * carries the actionable part (including an `AADSTSxxxxx` code). Surfacing it
 * verbatim turns "token exchange failed" into something diagnosable.
 */
const ErrorResponseSchema = z.object({
  error: z.string(),
  error_description: z.string().optional(),
});

export class EntraOAuth {
  constructor(private cfg: EntraConfig) {}

  private get authority(): string {
    return `https://login.microsoftonline.com/${encodeURIComponent(this.cfg.tenant)}`;
  }

  get redirectUri(): string {
    return `${this.cfg.publicBaseUrl}/auth/azure/callback`;
  }

  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      response_type: "code",
      redirect_uri: this.redirectUri,
      response_mode: "query",
      scope: ENTRA_SCOPES,
      state,
    });
    return `${this.authority}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<EntraTokens> {
    return this.tokenRequest({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.redirectUri,
    });
  }

  async refresh(refreshToken: string): Promise<EntraTokens> {
    return this.tokenRequest({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    });
  }

  private async tokenRequest(extra: Record<string, string>): Promise<EntraTokens> {
    const body = new URLSearchParams({
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      scope: ENTRA_SCOPES,
      ...extra,
    });
    const res = await fetch(`${this.authority}/oauth2/v2.0/token`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        accept: "application/json",
      },
      body,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`entra token request failed (${res.status}): ${describeError(text)}`);
    }
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error("entra token response was not JSON");
    }
    const parsed = TokenResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new Error("entra token response missing access_token");
    }
    // Entra omits expires_in only in unusual configurations; 3600 matches the
    // documented default and keeps the refresh path conservative.
    const expiresInSec = parsed.data.expires_in ?? 3600;
    return {
      accessToken: parsed.data.access_token,
      refreshToken: parsed.data.refresh_token,
      idToken: parsed.data.id_token,
      expiresAt: new Date(Date.now() + expiresInSec * 1000),
    };
  }
}

function describeError(text: string): string {
  try {
    const parsed = ErrorResponseSchema.safeParse(JSON.parse(text));
    if (parsed.success) {
      return parsed.data.error_description ?? parsed.data.error;
    }
  } catch {
    // fall through to the raw body
  }
  return text.slice(0, 500);
}

const IdTokenClaimsSchema = z.object({
  oid: z.string(),
  tid: z.string(),
  preferred_username: z.string().optional(),
  upn: z.string().optional(),
  name: z.string().optional(),
  email: z.string().optional(),
});

/**
 * Read the identity claims out of an Entra id token.
 *
 * NOTE ON VERIFICATION: the signature is not checked here, and does not need to
 * be. This token arrives as the direct response body of a server-to-server
 * `POST /oauth2/v2.0/token` over TLS, authenticated with our client secret —
 * not from the browser. That channel is the trust anchor. (An id token accepted
 * from a redirect, an `Authorization` header, or any client-supplied source
 * MUST be signature-verified against the tenant JWKS instead — do not reuse
 * this function for that.)
 */
export function parseIdTokenClaims(idToken: string): EntraProfile {
  const parts = idToken.split(".");
  if (parts.length < 2 || !parts[1]) {
    throw new Error("entra id token is not a JWT");
  }
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("entra id token payload is not valid JSON");
  }
  const parsed = IdTokenClaimsSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("entra id token is missing the oid/tid claims");
  }
  const c = parsed.data;
  const login = c.preferred_username ?? c.upn ?? c.oid;
  return {
    objectId: c.oid,
    tenantId: c.tid,
    login,
    name: c.name ?? null,
    // `email` is only present when the tenant populates it; preferred_username
    // is an email address in the overwhelming majority of tenants.
    email: c.email ?? (login.includes("@") ? login : null),
  };
}

/**
 * Best-effort tenant id from an Entra ACCESS token's `tid` claim.
 *
 * Access tokens for the Azure DevOps resource are JWTs, so the directory the
 * grant came from is readable without a round-trip. Unlike `parseIdTokenClaims`
 * this returns null rather than throwing: the value is diagnostic metadata, the
 * token format is not contractually guaranteed, and a connect must not fail
 * because a claim was missing.
 *
 * Same trust argument as `parseIdTokenClaims` — this token came from our own
 * server-to-server exchange, not from a client — and the same caveat: never use
 * this on a token supplied by a caller.
 */
export function tenantIdFromAccessToken(accessToken: string): string | null {
  const parts = accessToken.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      tid?: unknown;
    };
    return typeof payload.tid === "string" ? payload.tid : null;
  } catch {
    return null;
  }
}
