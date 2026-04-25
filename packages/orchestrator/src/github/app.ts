import { createAppAuth } from "@octokit/auth-app";
import { Octokit } from "@octokit/rest";
import { Webhooks } from "@octokit/webhooks";
import type { AppConfig } from "../config.js";

export interface GithubAppClient {
  app: Octokit;
  forInstallation: (installationId: number) => Promise<Octokit>;
  webhooks: Webhooks;
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

  const webhooks = new Webhooks({ secret: webhookSecret });

  return { app, forInstallation, webhooks };
}
