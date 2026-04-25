import { z } from "zod";

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  publicBaseUrl: string;
}

export interface UserTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
}

const TokenResponseSchema = z.object({
  access_token: z.string(),
  expires_in: z.number().optional(),
  refresh_token: z.string().optional(),
  refresh_token_expires_in: z.number().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

export interface ViewerProfile {
  id: number;
  login: string;
  name: string | null;
  email: string | null;
  avatarUrl: string | null;
}

const ViewerSchema = z.object({
  id: z.number(),
  login: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  avatar_url: z.string().nullable(),
});

export class GithubOAuth {
  constructor(private cfg: OAuthConfig) {}

  callbackUrl(): string {
    return `${this.cfg.publicBaseUrl}/auth/github/callback`;
  }

  buildAuthorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.cfg.clientId,
      redirect_uri: this.callbackUrl(),
      state,
    });
    return `https://github.com/login/oauth/authorize?${params.toString()}`;
  }

  async exchangeCode(code: string): Promise<UserTokens> {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        code,
        redirect_uri: this.callbackUrl(),
      }),
    });
    if (!res.ok) {
      throw new Error(`GitHub token exchange failed: ${res.status} ${await res.text()}`);
    }
    const json = TokenResponseSchema.parse(await res.json());
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : undefined,
    };
  }

  async refreshUserToken(refreshToken: string): Promise<UserTokens> {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({
        client_id: this.cfg.clientId,
        client_secret: this.cfg.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    if (!res.ok) {
      throw new Error(`GitHub refresh failed: ${res.status} ${await res.text()}`);
    }
    const json = TokenResponseSchema.parse(await res.json());
    return {
      accessToken: json.access_token,
      refreshToken: json.refresh_token,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000) : undefined,
    };
  }

  async getViewer(accessToken: string): Promise<ViewerProfile> {
    const res = await fetch("https://api.github.com/user", {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
    });
    if (!res.ok) {
      throw new Error(`GitHub /user failed: ${res.status} ${await res.text()}`);
    }
    const v = ViewerSchema.parse(await res.json());
    return {
      id: v.id,
      login: v.login,
      name: v.name,
      email: v.email,
      avatarUrl: v.avatar_url,
    };
  }
}
