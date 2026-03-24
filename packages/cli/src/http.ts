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

export class ApiClient {
  private readonly debug: boolean;
  private readonly apiKey: string | null;
  private readonly cliVersion: string | null;

  constructor(
    private readonly baseUrl: string,
    debugOrOptions?: boolean | { debug?: boolean; apiKey?: string | null; cliVersion?: string },
  ) {
    if (typeof debugOrOptions === 'object' && debugOrOptions !== null) {
      this.debug = debugOrOptions.debug ?? process.env.OPENCARA_DEBUG === '1';
      this.apiKey = debugOrOptions.apiKey ?? null;
      this.cliVersion = debugOrOptions.cliVersion ?? null;
    } else {
      this.debug = debugOrOptions ?? process.env.OPENCARA_DEBUG === '1';
      this.apiKey = null;
      this.cliVersion = null;
    }
  }

  private log(msg: string): void {
    if (this.debug) console.debug(`[ApiClient] ${msg}`);
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      h['Authorization'] = `Bearer ${this.apiKey}`;
    }
    if (this.cliVersion) {
      h['X-OpenCara-CLI-Version'] = this.cliVersion;
    }
    return h;
  }

  async get<T>(path: string): Promise<T> {
    this.log(`GET ${path}`);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'GET',
      headers: this.headers(),
    });
    return this.handleResponse<T>(res, path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    this.log(`POST ${path}`);
    const res = await fetch(`${this.baseUrl}${path}`, {
      method: 'POST',
      headers: this.headers(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return this.handleResponse<T>(res, path);
  }

  private async handleResponse<T>(res: Response, path: string): Promise<T> {
    if (!res.ok) {
      let message = `HTTP ${res.status}`;
      let errorCode: ErrorCode | undefined;
      let minimumVersion: string | undefined;
      try {
        const body = (await res.json()) as ErrorResponse & { minimum_version?: string };
        if (body.error && typeof body.error === 'object' && 'code' in body.error) {
          errorCode = body.error.code;
          message = body.error.message;
        }
        if (body.minimum_version) {
          minimumVersion = body.minimum_version;
        }
      } catch {
        // ignore parse errors — keep generic message
      }
      this.log(`${res.status} ${message} (${path})`);

      if (res.status === 426) {
        throw new UpgradeRequiredError(this.cliVersion ?? 'unknown', minimumVersion);
      }

      throw new HttpError(res.status, message, errorCode);
    }
    this.log(`${res.status} OK (${path})`);
    return (await res.json()) as T;
  }
}
