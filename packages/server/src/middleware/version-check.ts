import type { MiddlewareHandler } from 'hono';
import type { ErrorResponse } from '@opencara/shared';
import type { Env, AppVariables } from '../types.js';
import { MIN_CLI_VERSION } from '../version.js';

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
    const minParsed = parseSemver(MIN_CLI_VERSION);

    // Malformed version — allow (best effort)
    if (!clientParsed || !minParsed) {
      await next();
      return;
    }

    if (compareSemver(clientParsed, minParsed) < 0) {
      return c.json<ErrorResponse>(
        {
          error: {
            code: 'CLI_OUTDATED',
            message: `CLI version ${clientVersion} is below minimum ${MIN_CLI_VERSION}. Please upgrade: npm update -g opencara`,
          },
        },
        426,
      );
    }

    await next();
  };
}
