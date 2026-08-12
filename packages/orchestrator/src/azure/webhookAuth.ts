import { timingSafeEqual } from "node:crypto";

/**
 * HTTP Basic verification for inbound Azure DevOps service hooks.
 *
 * Azure DevOps does not sign webhook deliveries. Where the GitHub path verifies
 * an HMAC over the body (`x-hub-signature-256`), here the Basic-auth password
 * registered on the subscription is the ONLY thing separating a real delivery
 * from a forged one. Treat it with the same care as the GitHub webhook secret:
 * anyone holding it can drive agent runs.
 *
 * Consequence worth stating: because the secret is per-connection rather than
 * per-delivery, and the body is unsigned, a replayed delivery is
 * indistinguishable from a fresh one. Content-level dedup on the payload id
 * (`platform_events.delivery_id`) is what bounds that, not this check.
 */

/** Parse an `Authorization: Basic ...` header into its password half. */
export function parseBasicAuthPassword(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Basic\s+(.+)$/i.exec(header.trim());
  if (!match?.[1]) return null;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return null;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return null;
  return decoded.slice(sep + 1);
}

/**
 * Constant-time secret comparison.
 *
 * `timingSafeEqual` throws on length mismatch, which would itself leak length
 * through the error path — so lengths are compared first and both branches
 * still run a comparison of equal-length buffers.
 */
export function secretMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) {
    // Compare b against itself so the work done is independent of whether the
    // lengths matched, then return false regardless.
    timingSafeEqual(b, b);
    return false;
  }
  return timingSafeEqual(a, b);
}
