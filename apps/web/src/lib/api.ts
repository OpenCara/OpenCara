export class ApiError extends Error {
  constructor(
    public status: number,
    public body: unknown,
    // Parsed from the response's Retry-After header (ms), when present. The
    // orchestrator sets it on the 503 it returns when a session lookup races
    // past its deadline under DB pool pressure, so the client can back off for
    // the server-suggested interval instead of guessing.
    public retryAfterMs?: number,
  ) {
    super(`API ${status}`);
  }
}

// Retry-After is seconds (the orchestrator sends a small integer). Returns
// undefined for a missing/non-numeric header so callers fall back to backoff.
function parseRetryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("Retry-After");
  if (!raw) return undefined;
  const secs = Number(raw);
  return Number.isFinite(secs) && secs >= 0 ? secs * 1000 : undefined;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
): Promise<T> {
  const headers: Record<string, string> = {
    "X-Requested-With": "fetch",
  };
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const res = await fetch(path, {
    method,
    credentials: "include",
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  const parsed = text ? safeJson(text) : undefined;
  if (!res.ok) throw new ApiError(res.status, parsed ?? text, parseRetryAfterMs(res));
  return parsed as T;
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export const api = {
  get: <T>(p: string): Promise<T> => request<T>("GET", p),
  post: <T>(p: string, body?: unknown): Promise<T> => request<T>("POST", p, body),
  put: <T>(p: string, body?: unknown): Promise<T> => request<T>("PUT", p, body),
  patch: <T>(p: string, body?: unknown): Promise<T> => request<T>("PATCH", p, body),
  delete: <T>(p: string): Promise<T> => request<T>("DELETE", p),
};
