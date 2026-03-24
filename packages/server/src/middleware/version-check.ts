import type { MiddlewareHandler } from 'hono';
import type { Env, AppVariables } from '../types.js';
import { MIN_CLI_VERSION } from '../version.js';
import { apiError } from '../errors.js';

/**
 * Parse a semver string "major.minor.patch" into a numeric tuple.
 * Returns null for malformed strings.
 */
export function parseSemver(version: string): [number, number, number] | null {
  const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Compare two semver tuples.
 * Returns negative if a < b, 0 if equal, positive if a > b.
 */
function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] - b[i];
  }
  return 0;
}

/** Parsed MIN_CLI_VERSION — cached at module load to avoid re-parsing per request. */
const MIN_CLI_VERSION_PARSED = parseSemver(MIN_CLI_VERSION);

/**
 * Middleware that checks the `X-OpenCara-CLI-Version` header against
 * the server's minimum CLI version. Returns 426 Upgrade Required if
 * the client version is below the minimum.
 *
 * - If the header is missing, the request is allowed (backward compat).
 * - If the header is malformed, the request is allowed (best effort).
 */
export function versionCheck(): MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> {
  return async (c, next) => {
    const clientVersion = c.req.header('X-OpenCara-CLI-Version');

    // Missing header — allow for backward compatibility with old CLIs
    if (!clientVersion) {
      await next();
      return;
    }

    const clientParsed = parseSemver(clientVersion);

    // Malformed version — allow (best effort)
    if (!clientParsed || !MIN_CLI_VERSION_PARSED) {
      await next();
      return;
    }

    if (compareSemver(clientParsed, MIN_CLI_VERSION_PARSED) < 0) {
      return apiError(
        c,
        426,
        'CLI_OUTDATED',
        `CLI version ${clientVersion} is below minimum ${MIN_CLI_VERSION}. Please upgrade: npm update -g opencara`,
      );
    }

    await next();
  };
}
