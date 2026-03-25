import type { ErrorCode, ErrorResponse } from '@opencara/shared';

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly errorCode?: ErrorCode,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export class UpgradeRequiredError extends Error {
  constructor(
    public readonly currentVersion: string,
    public readonly minimumVersion?: string,
  ) {
    const minPart = minimumVersion ? ` Minimum required: ${minimumVersion}` : '';
    super(
      `Your CLI version (${currentVersion}) is outdated.${minPart} Please upgrade: npm update -g opencara`,
    );
    this.name = 'UpgradeRequiredError';
  }
}

/** Callback invoked when the server returns AUTH_TOKEN_EXPIRED. Returns a fresh token. */
export type TokenRefreshFn = () => Promise<string>;

export class ApiClient {
  private readonly debug: boolean;
  private authToken: string | null;
  private readonly cliVersion: string | null;
  private readonly versionOverride: string | null;
  private readonly onTokenRefresh: TokenRefreshFn | null;

  constructor(
    private readonly baseUrl: string,
    debugOrOptions?:
      | boolean
      | {
          debug?: boolean;
          authToken?: string | null;
          cliVersion?: string;
          versionOverride?: string | null;
          onTokenRefresh?: TokenRefreshFn;
        },
  ) {
    if (typeof debugOrOptions === 'object' && debugOrOptions !== null) {
      this.debug = debugOrOptions.debug ?? process.env.OPENCARA_DEBUG === '1';
      this.authToken = debugOrOptions.authToken ?? null;
      this.cliVersion = debugOrOptions.cliVersion ?? null;
      this.versionOverride = debugOrOptions.versionOverride ?? null;
      this.onTokenRefresh = debugOrOptions.onTokenRefresh ?? null;
    } else {
      this.debug = debugOrOptions ?? process.env.OPENCARA_DEBUG === '1';
      this.authToken = null;
      this.cliVersion = null;
      this.versionOverride = null;
      this.onTokenRefresh = null;
    }
  }

  /** Get the current auth token (may have been refreshed since construction). */
  get currentToken(): string | null {
    return this.authToken;
  }

  private log(msg: string): void {
    if (this.debug) console.debug(`[ApiClient] ${msg}`);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.authToken) {
      h['Authorization'] = `Bearer ${this.authToken}`;
    }
    if (this.cliVersion) {
      h['X-OpenCara-CLI-Version'] = this.cliVersion;
    }
    if (this.versionOverride) {
      h['Cloudflare-Workers-Version-Overrides'] = this.versionOverride;
    }
    return h;
  }

  /** Parse error body from a non-OK response. */
  private async parseErrorBody(res: Response): Promise<{
    message: string;
    errorCode?: ErrorCode;
    minimumVersion?: string;
  }> {
    let message = `HTTP ${res.status}`;
    let errorCode: ErrorCode | undefined;
    let minimumVersion: string | undefined;
    try {
      const errBody = (await res.json()) as ErrorResponse & { minimum_version?: string };
      if (errBody.error && typeof errBody.error === 'object' && 'code' in errBody.error) {
        errorCode = errBody.error.code;
        message = errBody.error.message;
      }
      if (errBody.minimum_version) {
        minimumVersion = errBody.minimum_version;
      }
    } catch {
      // ignore parse errors — keep generic message
    }
    return { message, errorCode, minimumVersion };
  }

  async get<T>(path: string): Promise<T> {
    this.log(`GET ${path}`);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: this.headers(),
    });
    return this.handleResponse<T>(res, path, 'GET');
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    this.log(`POST ${path}`);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.handleResponse<T>(res, path, 'POST', body);
  }

  private async handleResponse<T>(
    res: Response,
    path: string,
    method: string,
    body?: unknown,
  ): Promise<T> {
    if (!res.ok) {
      const { message, errorCode, minimumVersion } = await this.parseErrorBody(res);
      this.log(`${res.status} ${message} (${path})`);

      if (res.status === 426) {
        throw new UpgradeRequiredError(this.cliVersion ?? 'unknown', minimumVersion);
      }

      // Token expired — attempt refresh and retry once
      if (errorCode === 'AUTH_TOKEN_EXPIRED' && this.onTokenRefresh) {
        this.log('Token expired, attempting refresh...');
        try {
          this.authToken = await this.onTokenRefresh();
          this.log('Token refreshed, retrying request');
          const retryRes = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: this.headers(),
            body: body !== undefined ? JSON.stringify(body) : undefined,
          });
          return this.handleRetryResponse<T>(retryRes, path);
        } catch (refreshErr) {
          this.log(`Token refresh failed: ${(refreshErr as Error).message}`);
          throw new HttpError(res.status, message, errorCode);
        }
      }

      throw new HttpError(res.status, message, errorCode);
    }
    this.log(`${res.status} OK (${path})`);
    return (await res.json()) as T;
  }

  /** Handle response for a retry after token refresh — no second refresh attempt. */
  private async handleRetryResponse<T>(res: Response, path: string): Promise<T> {
    if (!res.ok) {
      const { message, errorCode, minimumVersion } = await this.parseErrorBody(res);
      this.log(`${res.status} ${message} (${path}) [retry]`);
      if (res.status === 426) {
        throw new UpgradeRequiredError(this.cliVersion ?? 'unknown', minimumVersion);
      }
      throw new HttpError(res.status, message, errorCode);
    }
    this.log(`${res.status} OK (${path}) [retry]`);
    return (await res.json()) as T;
  }
}
