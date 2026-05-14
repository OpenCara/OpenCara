/**
 * Detect "this installation no longer exists on GitHub" — Octokit's
 * createAppAuth surfaces it as a 404 from POST
 * /app/installations/{id}/access_tokens when we try to mint a token.
 * Distinct from a generic 404 (e.g. "board not found" from a GraphQL call),
 * so we match the request URL too.
 */
export function isInstallationGoneError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; request?: { url?: unknown } };
  if (e.status !== 404) return false;
  const url = e.request?.url;
  return typeof url === "string" && url.includes("/access_tokens");
}

export const INSTALLATION_GONE_BODY = {
  error: "GitHub App installation no longer exists on GitHub",
  code: "installation_gone" as const,
};
