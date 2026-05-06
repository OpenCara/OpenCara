import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { Webhooks } from "@octokit/webhooks";
import type { AppConfig } from "../config.js";

export interface MintEphemeralTokenOptions {
  installationId: number;
  /** When set, scopes the token to these repos (subset of the installation's
   * repositories). Omit for installation-wide. */
  repositoryIds?: number[];
  /** Subset of the installation's permissions. Omit to inherit defaults. */
  permissions?: Record<string, "read" | "write">;
}

export interface EphemeralToken {
  token: string;
  expiresAt: string;
}

export interface GithubAppClient {
  app: Octokit;
  forInstallation: (installationId: number) => Promise<Octokit>;
  webhooks: Webhooks;
  /** Mint a short-lived (≤1h) installation access token for handing to a
   * subprocess (agent runs). Does NOT populate the long-lived `tokenCache`
   * used by `forInstallation` — its tokens get revoked under it on agent
   * finish, which would break in-flight server-internal traffic. */
  mintEphemeralToken: (opts: MintEphemeralTokenOptions) => Promise<EphemeralToken>;
  /** Best-effort revoke. The token expires in ≤1h regardless, so failure
   * is logged + ignored by callers. */
  revokeToken: (token: string) => Promise<void>;
}

export function createGithubAppClient(
  appCfg: NonNullable<AppConfig["github"]>,
  webhookSecret: string,
): GithubAppClient {
  const appAuth = {
    appId: appCfg.appId,
    privateKey: appCfg.privateKeyPem,
    clientId: appCfg.clientId,
    clientSecret: appCfg.clientSecret,
  };

  const app = new Octokit({
    authStrategy: createAppAuth,
    auth: appAuth,
  });

  const tokenCache = new Map<number, { token: string; expiresAt: number }>();
  const SAFETY_MS = 5 * 60 * 1000;

  const forInstallation = async (installationId: number): Promise<Octokit> => {
    const now = Date.now();
    const cached = tokenCache.get(installationId);
    if (cached && cached.expiresAt - SAFETY_MS > now) {
      return new Octokit({ auth: cached.token });
    }
    const installAuth = createAppAuth(appAuth);
    const result = (await installAuth({
      type: "installation",
      installationId,
    })) as { token: string; expiresAt: string };
    tokenCache.set(installationId, {
      token: result.token,
      expiresAt: new Date(result.expiresAt).getTime(),
    });
    return new Octokit({ auth: result.token });
  };

  const mintEphemeralToken = async (
    opts: MintEphemeralTokenOptions,
  ): Promise<EphemeralToken> => {
    const body: Record<string, unknown> = {};
    if (opts.repositoryIds && opts.repositoryIds.length > 0) {
      body.repository_ids = opts.repositoryIds;
    }
    if (opts.permissions) {
      body.permissions = opts.permissions;
    }
    const res = await app.request("POST /app/installations/{installation_id}/access_tokens", {
      installation_id: opts.installationId,
      ...body,
    });
    return { token: res.data.token, expiresAt: res.data.expires_at };
  };

  const revokeToken = async (token: string): Promise<void> => {
    // DELETE /installation/token authenticates with the installation token
    // itself, not the App JWT — so we use a one-shot Octokit with that token
    // rather than the app-level client.
    const oct = new Octokit({ auth: token });
    await oct.request("DELETE /installation/token");
  };

  const webhooks = new Webhooks({ secret: webhookSecret });

  return { app, forInstallation, webhooks, mintEphemeralToken, revokeToken };
}
