export class ApiError extends Error {
  constructor(public status: number, public body: unknown) {
    super(`API ${status}`);
  }
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
  if (!res.ok) throw new ApiError(res.status, parsed ?? text);
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
  delete: <T>(p: string): Promise<T> => request<T>("DELETE", p),
};
