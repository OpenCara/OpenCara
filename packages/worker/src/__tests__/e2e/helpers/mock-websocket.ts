/**
 * Enhanced WebSocket mocks with message tracking for E2E tests.
 *
 * Unlike the basic vitest.setup.ts mocks, these track sent/received messages,
 * support bidirectional communication, and track open/close state.
 */

export interface MockWebSocket {
  send(data: string | ArrayBuffer): void;
  close(code?: number, reason?: string): void;
  accept(): void;
  readyState: number;
  addEventListener(type: string, handler: (...args: unknown[]) => void): void;
  removeEventListener(type: string, handler: (...args: unknown[]) => void): void;

  // Test helpers — messages this socket originated
  sentMessages: string[];
  // Messages received from the partner socket
  receivedMessages: string[];
  getSentParsed<T = unknown>(): T[];
  getLastSentParsed<T = unknown>(): T | undefined;
  getReceivedParsed<T = unknown>(): T[];
  getLastReceivedParsed<T = unknown>(): T | undefined;
  isClosed: boolean;
  closeCode?: number;
  closeReason?: string;
}

function createMockWebSocket(): MockWebSocket {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  const ws: MockWebSocket = {
    readyState: 1, // OPEN
    sentMessages: [],
    receivedMessages: [],
    isClosed: false,
    closeCode: undefined,
    closeReason: undefined,

    accept() {
      // No-op for compatibility with CF Workers API
    },

    send(data: string | ArrayBuffer) {
      if (ws.isClosed) return;
      const str = typeof data === 'string' ? data : new TextDecoder().decode(data);
      ws.sentMessages.push(str);
      // Deliver to partner if linked
      if ((ws as MockWebSocketInternal)._partner) {
        const partner = (ws as MockWebSocketInternal)._partner!;
        partner.receivedMessages.push(str);
        const fns = (partner as MockWebSocketInternal)._listeners.get('message') ?? [];
        for (const fn of fns) {
          fn({ data: str });
        }
      }
    },

    close(code?: number, reason?: string) {
      if (ws.isClosed) return;
      ws.isClosed = true;
      ws.closeCode = code;
      ws.closeReason = reason;
      ws.readyState = 3; // CLOSED
      // Notify partner
      if ((ws as MockWebSocketInternal)._partner) {
        const partner = (ws as MockWebSocketInternal)._partner!;
        partner.isClosed = true;
        partner.closeCode = code;
        partner.closeReason = reason;
        partner.readyState = 3;
        const fns = (partner as MockWebSocketInternal)._listeners.get('close') ?? [];
        for (const fn of fns) {
          fn({ code, reason, wasClean: true });
        }
      }
    },

    addEventListener(type: string, handler: (...args: unknown[]) => void) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type)!.push(handler);
    },

    removeEventListener(type: string, handler: (...args: unknown[]) => void) {
      const fns = listeners.get(type);
      if (fns) {
        const idx = fns.indexOf(handler);
        if (idx >= 0) fns.splice(idx, 1);
      }
    },

    getSentParsed<T = unknown>(): T[] {
      return ws.sentMessages.map((m) => JSON.parse(m) as T);
    },

    getLastSentParsed<T = unknown>(): T | undefined {
      if (ws.sentMessages.length === 0) return undefined;
      return JSON.parse(ws.sentMessages[ws.sentMessages.length - 1]) as T;
    },

    getReceivedParsed<T = unknown>(): T[] {
      return ws.receivedMessages.map((m) => JSON.parse(m) as T);
    },

    getLastReceivedParsed<T = unknown>(): T | undefined {
      if (ws.receivedMessages.length === 0) return undefined;
      return JSON.parse(ws.receivedMessages[ws.receivedMessages.length - 1]) as T;
    },
  };

  (ws as MockWebSocketInternal)._listeners = listeners;
  return ws;
}

interface MockWebSocketInternal extends MockWebSocket {
  _listeners: Map<string, Array<(...args: unknown[]) => void>>;
  _partner?: MockWebSocket;
}

export interface MockWebSocketPair {
  client: MockWebSocket;
  server: MockWebSocket;
}

export function createMockWebSocketPair(): MockWebSocketPair {
  const client = createMockWebSocket();
  const server = createMockWebSocket();
  (client as MockWebSocketInternal)._partner = server;
  (server as MockWebSocketInternal)._partner = client;
  return { client, server };
}

/**
 * Install a WebSocketPair factory that tracks all created pairs.
 * Returns a controller for test assertions and cleanup.
 */
export function installMockWebSocketPair() {
  const pairs: MockWebSocketPair[] = [];

  (globalThis as Record<string, unknown>).WebSocketPair = class WebSocketPair {
    0: MockWebSocket;
    1: MockWebSocket;
    constructor() {
      const pair = createMockWebSocketPair();
      this[0] = pair.client;
      this[1] = pair.server;
      pairs.push(pair);
    }
  };

  return {
    getLastPair(): MockWebSocketPair | undefined {
      return pairs[pairs.length - 1];
    },
    getAllPairs(): MockWebSocketPair[] {
      return [...pairs];
    },
    reset() {
      pairs.length = 0;
    },
  };
}
