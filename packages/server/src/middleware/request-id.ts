import type { MiddlewareHandler } from 'hono';
import type { Env, AppVariables } from '../types.js';
import { Logger } from '../logger.js';

/**
 * Hono middleware that generates a unique request ID, attaches a structured
 * Logger to the context, and sets the X-Request-Id response header.
 */
export function requestIdMiddleware(): MiddlewareHandler<{
  Bindings: Env;
  Variables: AppVariables;
}> {
  return async (c, next) => {
    const requestId = crypto.randomUUID();
    const logger = new Logger(requestId);
    c.set('logger', logger);
    c.set('requestId', requestId);
    c.header('X-Request-Id', requestId);
    await next();
  };
}
