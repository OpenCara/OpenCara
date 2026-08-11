import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  EntraOAuth,
  parseIdTokenClaims,
  ENTRA_SCOPES,
  AZURE_DEVOPS_RESOURCE_ID,
} from "../entra.js";
import { displayLogin } from "../../auth/session.js";

const cfg = {
  clientId: "client-123",
  clientSecret: "secret-456",
  tenant: "common",
  publicBaseUrl: "https://opencara.example",
};

/** Build an unsigned JWT with the given payload — shape only, no crypto. */
function idToken(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.sig`;
}

describe("ENTRA_SCOPES", () => {
  it("requests offline_access so a refresh token comes back", () => {
    // Without this the connection silently dies ~1h after it is made.
    assert.ok(ENTRA_SCOPES.split(" ").includes("offline_access"));
  });

  it("requests the Azure DevOps resource's default scope", () => {
    assert.ok(ENTRA_SCOPES.includes(`${AZURE_DEVOPS_RESOURCE_ID}/.default`));
  });

  it("requests openid so an id token is issued", () => {
    assert.ok(ENTRA_SCOPES.split(" ").includes("openid"));
  });
});

describe("EntraOAuth.buildAuthorizeUrl", () => {
  it("targets the configured tenant's v2.0 authorize endpoint", () => {
    const url = new URL(new EntraOAuth(cfg).buildAuthorizeUrl("state-abc"));
    assert.equal(url.origin, "https://login.microsoftonline.com");
    assert.equal(url.pathname, "/common/oauth2/v2.0/authorize");
  });

  it("carries the client id, state, redirect uri and scopes", () => {
    const url = new URL(new EntraOAuth(cfg).buildAuthorizeUrl("state-abc"));
    assert.equal(url.searchParams.get("client_id"), "client-123");
    assert.equal(url.searchParams.get("state"), "state-abc");
    assert.equal(url.searchParams.get("response_type"), "code");
    assert.equal(
      url.searchParams.get("redirect_uri"),
      "https://opencara.example/auth/azure/callback",
    );
    assert.equal(url.searchParams.get("scope"), ENTRA_SCOPES);
  });

  it("never puts the client secret in a browser-visible URL", () => {
    const url = new EntraOAuth(cfg).buildAuthorizeUrl("state-abc");
    assert.ok(!url.includes("secret-456"));
  });

  it("url-encodes a tenant GUID into the path", () => {
    const url = new EntraOAuth({ ...cfg, tenant: "8a1b-tenant" }).buildAuthorizeUrl("s");
    assert.ok(new URL(url).pathname.startsWith("/8a1b-tenant/"));
  });
});

describe("EntraOAuth token exchange", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function stubFetch(status: number, body: unknown) {
    const calls: { url: string; body: string }[] = [];
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), body: String(init?.body ?? "") });
      return {
        ok: status >= 200 && status < 300,
        status,
        text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
      };
    }) as unknown as typeof fetch;
    return calls;
  }

  it("posts the authorization code to the token endpoint", async () => {
    const calls = stubFetch(200, { access_token: "at", expires_in: 3600 });
    await new EntraOAuth(cfg).exchangeCode("the-code");

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, "https://login.microsoftonline.com/common/oauth2/v2.0/token");
    const sent = new URLSearchParams(calls[0]!.body);
    assert.equal(sent.get("grant_type"), "authorization_code");
    assert.equal(sent.get("code"), "the-code");
    assert.equal(sent.get("client_secret"), "secret-456");
  });

  it("returns the refresh token and a concrete expiry", async () => {
    stubFetch(200, { access_token: "at", refresh_token: "rt", expires_in: 60 });
    const before = Date.now();
    const tokens = await new EntraOAuth(cfg).exchangeCode("c");

    assert.equal(tokens.accessToken, "at");
    assert.equal(tokens.refreshToken, "rt");
    const ms = tokens.expiresAt.getTime() - before;
    assert.ok(ms > 55_000 && ms <= 61_000, `expiry ${ms}ms out of range`);
  });

  it("defaults the lifetime when expires_in is absent", async () => {
    stubFetch(200, { access_token: "at" });
    const tokens = await new EntraOAuth(cfg).exchangeCode("c");
    assert.ok(tokens.expiresAt.getTime() > Date.now());
  });

  it("sends grant_type=refresh_token when refreshing", async () => {
    const calls = stubFetch(200, { access_token: "at2", expires_in: 3600 });
    await new EntraOAuth(cfg).refresh("old-refresh");

    const sent = new URLSearchParams(calls[0]!.body);
    assert.equal(sent.get("grant_type"), "refresh_token");
    assert.equal(sent.get("refresh_token"), "old-refresh");
  });

  // Entra's AADSTS codes are the whole diagnostic value of a failed exchange;
  // collapsing them to "request failed" makes misconfiguration untraceable.
  it("surfaces the AADSTS error_description on failure", async () => {
    stubFetch(400, {
      error: "invalid_client",
      error_description: "AADSTS7000215: Invalid client secret provided.",
    });
    await assert.rejects(
      new EntraOAuth(cfg).exchangeCode("c"),
      /AADSTS7000215: Invalid client secret provided/,
    );
  });

  it("still reports something useful when the error body isn't JSON", async () => {
    stubFetch(502, "<html>Bad Gateway</html>");
    await assert.rejects(new EntraOAuth(cfg).exchangeCode("c"), /502.*Bad Gateway/s);
  });

  it("rejects a 200 with no access_token rather than returning undefined", async () => {
    stubFetch(200, { token_type: "Bearer" });
    await assert.rejects(new EntraOAuth(cfg).exchangeCode("c"), /missing access_token/);
  });
});

describe("parseIdTokenClaims", () => {
  it("reads oid and tid as the identity key", () => {
    const profile = parseIdTokenClaims(
      idToken({ oid: "obj-1", tid: "tenant-1", preferred_username: "ada@contoso.com" }),
    );
    assert.equal(profile.objectId, "obj-1");
    assert.equal(profile.tenantId, "tenant-1");
    assert.equal(profile.login, "ada@contoso.com");
  });

  it("falls back to upn when preferred_username is absent", () => {
    const profile = parseIdTokenClaims(
      idToken({ oid: "o", tid: "t", upn: "grace@contoso.com" }),
    );
    assert.equal(profile.login, "grace@contoso.com");
  });

  it("derives email from the username when no email claim is present", () => {
    const profile = parseIdTokenClaims(
      idToken({ oid: "o", tid: "t", preferred_username: "ada@contoso.com" }),
    );
    assert.equal(profile.email, "ada@contoso.com");
  });

  it("leaves email null when the username is not an address", () => {
    const profile = parseIdTokenClaims(
      idToken({ oid: "o", tid: "t", preferred_username: "ada" }),
    );
    assert.equal(profile.email, null);
  });

  it("falls back to the oid when the token carries no username at all", () => {
    const profile = parseIdTokenClaims(idToken({ oid: "obj-9", tid: "t" }));
    assert.equal(profile.login, "obj-9");
  });

  it("rejects a token missing the oid/tid claims", () => {
    assert.throws(
      () => parseIdTokenClaims(idToken({ preferred_username: "ada@contoso.com" })),
      /missing the oid\/tid claims/,
    );
  });

  it("rejects a non-JWT string", () => {
    assert.throws(() => parseIdTokenClaims("not-a-jwt"), /not a JWT/);
  });

  it("rejects a JWT whose payload isn't JSON", () => {
    const bad = `${Buffer.from("{}").toString("base64url")}.${Buffer.from(
      "nonsense",
    ).toString("base64url")}.sig`;
    assert.throws(() => parseIdTokenClaims(bad), /not valid JSON/);
  });
});

describe("displayLogin", () => {
  it("prefers the GitHub login", () => {
    assert.equal(
      displayLogin({ id: "01ABCDEF", githubLogin: "quabug", name: "Q", email: "q@x.io" }),
      "quabug",
    );
  });

  it("falls back to the display name for an Entra user", () => {
    assert.equal(
      displayLogin({ id: "01ABCDEF", githubLogin: null, name: "Ada Lovelace" }),
      "Ada Lovelace",
    );
  });

  it("falls back to the email local-part", () => {
    assert.equal(
      displayLogin({ id: "01ABCDEF", githubLogin: null, name: null, email: "ada@contoso.com" }),
      "ada",
    );
  });

  it("never returns an empty string", () => {
    const out = displayLogin({ id: "01ABCDEFGH", githubLogin: null, name: null, email: null });
    assert.ok(out.length > 0);
    // Last 6 chars of the ULID — enough to disambiguate in a UI list.
    assert.equal(out, "user-CDEFGH");
  });
});
