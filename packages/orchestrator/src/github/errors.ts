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

/**
 * Detect "you can't review your own pull request" — GitHub returns 422 with
 * one of these two messages when the App identity backing
 * `POST /repos/{o}/{r}/pulls/{n}/reviews` is the same as the PR author:
 *
 *   "Can not request changes on your own pull request"
 *   "Can not approve your own pull request"
 *
 * Note the asymmetry — REQUEST_CHANGES has "on your" between the verb and
 * "own", APPROVE does not. The regex accepts both forms.
 *
 * Caller passes the original review `event` so we only treat this as a
 * self-review for the two events that GitHub actually rejects on a self-PR.
 * COMMENT cannot trip this and should not be downgraded; anything else
 * indicates a programming error and should propagate as-is.
 */
export function isSelfReviewError(err: unknown, event: string): boolean {
  if (event !== "APPROVE" && event !== "REQUEST_CHANGES") return false;
  if (typeof err !== "object" || err === null) return false;
  const e = err as { status?: unknown; message?: unknown };
  if (e.status !== 422) return false;
  const msg = typeof e.message === "string" ? e.message : "";
  return /can\s*not (?:request changes|approve)(?: (?:on )?your)? own pull request/i.test(
    msg,
  );
}
