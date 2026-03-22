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

export class ApiClient {
  private readonly debug: boolean;

  constructor(
    private readonly baseUrl: string,
    debug?: boolean,
  ) {
    this.debug = debug ?? process.env.OPENCARA_DEBUG === '1';
  }

  private log(msg: string): void {
    if (this.debug) console.debug(`[ApiClient] ${msg}`);
  }

  private headers(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
    };
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
      try {
        const body = (await res.json()) as ErrorResponse;
        if (body.error && typeof body.error === 'object' && 'code' in body.error) {
          // Structured error response
          errorCode = body.error.code;
          message = body.error.message;
        }
      } catch {
        // ignore parse errors — keep generic message
      }
      this.log(`${res.status} ${message} (${path})`);
      throw new HttpError(res.status, message, errorCode);
    }
    this.log(`${res.status} OK (${path})`);
    return (await res.json()) as T;
  }
}
