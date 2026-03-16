/**
 * Vitest setup file: provides mock Cloudflare Workers globals
 * that are not available in the Node.js test environment.
 */

function createMockWebSocket() {
  return {
    send: () => {},
    close: () => {},
    readyState: 1,
    addEventListener: () => {},
    removeEventListener: () => {},
  };
}

if (typeof (globalThis as Record<string, unknown>).DurableObject === 'undefined') {
  (globalThis as Record<string, unknown>).DurableObject = class DurableObject {
    protected ctx: unknown;
    protected env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  };
}

if (typeof (globalThis as Record<string, unknown>).WebSocketPair === 'undefined') {
  (globalThis as Record<string, unknown>).WebSocketPair = class WebSocketPair {
    0: unknown;
    1: unknown;
    constructor() {
      this[0] = createMockWebSocket();
      this[1] = createMockWebSocket();
    }
  };
}
