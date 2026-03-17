/**
 * Durable Object mocks that create real DO instances with mock state.
 *
 * The mock namespace creates actual AgentConnection / TaskTimeout instances,
 * so all DO routing and logic runs for real. Only the state storage and
 * WebSocket infrastructure are mocked.
 */

import type { MockWebSocket } from './mock-websocket.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DOConstructor = new (state: MockDurableObjectState, env: any) => any;

export class MockDurableObjectStorage {
  private data = new Map<string, unknown>();
  private alarmTime: number | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private doInstance: any = null;

  async get<T = unknown>(key: string): Promise<T | undefined> {
    return this.data.get(key) as T | undefined;
  }

  async put(key: string, value: unknown): Promise<void> {
    this.data.set(key, value);
  }

  async delete(key: string): Promise<boolean> {
    return this.data.delete(key);
  }

  async setAlarm(time: number): Promise<void> {
    this.alarmTime = time;
  }

  async deleteAlarm(): Promise<void> {
    this.alarmTime = null;
  }

  async getAlarm(): Promise<number | null> {
    return this.alarmTime;
  }

  /** Test helper: manually trigger the DO's alarm() */
  async fireAlarm(): Promise<void> {
    if (this.doInstance && typeof this.doInstance.alarm === 'function') {
      this.alarmTime = null;
      await this.doInstance.alarm();
    }
  }

  /** @internal Link to DO instance for alarm firing */
  _setDOInstance(instance: unknown): void {
    this.doInstance = instance;
  }

  /** Test helper: get raw data */
  getRawData(): Map<string, unknown> {
    return this.data;
  }
}

export class MockDurableObjectState {
  storage: MockDurableObjectStorage;
  private webSockets: MockWebSocket[] = [];
  private id: string;

  constructor(id: string) {
    this.id = id;
    this.storage = new MockDurableObjectStorage();
  }

  acceptWebSocket(ws: unknown): void {
    this.webSockets.push(ws as MockWebSocket);
  }

  getWebSockets(): MockWebSocket[] {
    return this.webSockets.filter((ws) => !ws.isClosed);
  }

  getId(): string {
    return this.id;
  }

  /** Test helper: remove all WebSockets */
  clearWebSockets(): void {
    this.webSockets = [];
  }
}

interface MockDurableObjectId {
  name: string;
  toString(): string;
}

interface MockDurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export class MockDurableObjectNamespace<T = unknown> {
  private DOClass: DOConstructor;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private env: any;
  private instances = new Map<string, T>();
  private states = new Map<string, MockDurableObjectState>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(DOClass: DOConstructor, env: any) {
    this.DOClass = DOClass;
    this.env = env;
  }

  idFromName(name: string): MockDurableObjectId {
    return { name, toString: () => name };
  }

  get(id: MockDurableObjectId | { name: string }): MockDurableObjectStub {
    const name = (id as MockDurableObjectId).name;
    if (!this.instances.has(name)) {
      const state = new MockDurableObjectState(name);
      const instance = new this.DOClass(state, this.env) as T;
      state.storage._setDOInstance(instance);
      this.instances.set(name, instance);
      this.states.set(name, state);
    }

    const instance = this.instances.get(name)!;
    return {
      async fetch(request: Request): Promise<Response> {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (instance as any).fetch(request);
      },
    };
  }

  /** Direct access to DO instance for test assertions */
  getInstance(name: string): T | undefined {
    // Ensure created
    if (!this.instances.has(name)) {
      this.get(this.idFromName(name));
    }
    return this.instances.get(name);
  }

  /** Direct access to DO state for test assertions */
  getState(name: string): MockDurableObjectState | undefined {
    if (!this.states.has(name)) {
      this.get(this.idFromName(name));
    }
    return this.states.get(name);
  }

  /** Fire alarm on a specific DO instance */
  async fireAlarm(name: string): Promise<void> {
    const state = this.states.get(name);
    if (state) {
      await state.storage.fireAlarm();
    }
  }

  /** Reset all instances */
  reset(): void {
    this.instances.clear();
    this.states.clear();
  }
}
