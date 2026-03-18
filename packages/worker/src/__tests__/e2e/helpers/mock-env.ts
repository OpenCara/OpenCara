/**
 * E2E test context factory that composes all mocks into a complete Env.
 *
 * Usage:
 *   vi.mock('../../db.js', () => ({ createSupabaseClient: vi.fn() }));
 *   // In beforeEach:
 *   const ctx = createE2EContext();
 *   vi.mocked(createSupabaseClient).mockReturnValue(ctx.supabase.client as any);
 */

import type { Env } from '../../../env.js';
import { hashApiKey, generateApiKey } from '../../../auth.js';
import { AgentConnection } from '../../../agent-connection.js';
import { TaskTimeout } from '../../../task-timeout.js';
import { createMockSupabase, type MockSupabase } from './mock-supabase.js';
import {
  createGitHubMock,
  installGitHubFetchInterceptor,
  type GitHubMock,
  type GitHubMockOptions,
} from './mock-github.js';
import { MockDurableObjectNamespace } from './mock-durable-objects.js';
import { installMockWebSocketPair, type MockWebSocketPair } from './mock-websocket.js';

// Import the Worker's default export for direct fetch invocation
import worker from '../../../index.js';

const WEBHOOK_SECRET = 'test-webhook-secret';

/**
 * Patch Response to accept status 101 (WebSocket upgrade).
 * Node.js only allows 200-599, but Cloudflare Workers use 101 for WebSocket responses.
 */
const OriginalResponse = globalThis.Response;
class PatchedResponse extends OriginalResponse {
  private _ws101Status?: number;
  private _webSocket?: unknown;

  constructor(body?: BodyInit | null, init?: ResponseInit & { webSocket?: unknown }) {
    if (init?.status === 101) {
      // Create with status 200, then override
      super(body, { ...init, status: 200 });
      this._ws101Status = 101;
      this._webSocket = init.webSocket;
    } else {
      super(body, init);
    }
  }

  override get status(): number {
    return this._ws101Status ?? super.status;
  }

  get webSocket(): WebSocket | null {
    return (this._webSocket as WebSocket) ?? null;
  }
}
globalThis.Response = PatchedResponse as typeof Response;

// A valid RSA PKCS#8 PEM key for generating GitHub App JWTs in tests.
// The actual JWT signature doesn't matter because the GitHub API fetch is intercepted.
const TEST_RSA_PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCxoUBXtV4j3NpC
MDtMai478Grs171G+YjLcu30iRKfT1Mc9CBG9GHwvH8bYPmK1YRsU+VPkoZPyn4v
b1bHBJlywgdzyV/gqSpCUwmwMY/7jxNJSJm6P9twsu723TE9sMDdFJGPULUBMGsn
f6EHHYHDAHU40vHp9Dj8JuqQEhtWHMjOo7VhKsZSLWqo+v6FOwVhboEcDbrwMZFj
xZ03QGsj45IVSyS3Zh3yKZ3b390lyHjrVXSRKsgEJlrkGFlRGBupWHLV3HqkbAdp
6RmrJp3NeSv2gclQrsKNe4EFX27tbABEVQF2yApDGXcXL8pavaOIc3E2f6N3+PRp
DceXOt3bAgMBAAECggEAVnyabPogX5rJZF/Ch5bNcx7AmRgEDzoxWknXxXA2Mn43
jAnra1DTHRlSVBzX87q5cts4dBF2NwRzgxoVaOp64k7JvR0oAyWqr0dqGLFRFx1X
OR/RxccQy+M7idQyBQT6Ksq4gsy7jNwr2DwCxgmeZDllWekPo6dnVZKHM+W1DKw/
Dm/3I9jx4kSrgk60few7LcawJMID2sU5ukxhY1lIPsTa2eDkNqDl6cSBT0M5+JnC
26u99eN9lQKM0fK8TnEBzwyKzrf8IPxk1YkiyVSl9nR1qoJfo42CS1r3jW292wao
sZUfYrbBTKUe9kgU19T/bjRqtgw+O99fXo0xdjzM9QKBgQDwV/gcXjvSPUUn52yA
CgUQjPqN+YBHLFcQJ1vxmGA9NZ0CH5pIe3C/UndvR8iGoGdtoSU3lMvdW7iE3RW3
TVcL6Ga7o8RslFl7NoUph9jo1imhgrEnc+MkoKZXFoCKOTelI32zIId8cU2PWqT9
81/hXBMqYec3T8I8wLyjZavypQKBgQC9M3O4E6n/H4lyR1ZWPAStGl0cG3aWLhr6
q9XEQJ+wMuKGxqC4z1OMMgO1OJuvt/nv1CRLn0afyULGj0VtgDADaQt4Nyl2HQA2
l1hmGYtiCu9Q0192iVqtwD+dFF7RH1XbYY2zvKw12Pcli0hTUWnWq3DO4B/W1n5n
/ie8dfUmfwKBgDDQvT0Nyrqt5SDwuTHcVyEAcVdqyKosEFbgl6UfXNSx0fz/bDey
krjZSBbbDpiBdeBnbYa3exyvp2+c8+8yDy8E+fC8l4WyL+Z9sVg5Fk5cSUJbqB2q
RQVId+CSWnM4oduxtLMwNTSKUsV+FKrbxqqgJ+hg0DSEx5/NScMqQF1dAoGAbvfM
eTxfSlkO3k3k33MYMwbxcVjSNscX38oE+LQGdOuDXRUGkx5WnDWBYzquZWN8XiOI
ninu3CzI03iYed7jSjzEE2AXG0VrKJmfqVJ2I6zSLA+tP/LTknDdXp3h9rlwO9l9
qNuSDYsReZ21b9iiQNwQr+VYB0OKpCe22pw8irUCgYEA1l+yXx/mDa1vTyE4BIHz
ivq558D35InA8h5RkjsaWiC6P6fRKNBM/y8df0I147Ah6wjELAsWOPAId8ONHVUf
0SQimiy09QlygZQh/CaxOx5WLbHIEDBpC+C5DkrbTSs/uMeYwHjUiH0/GQN6Q8D0
6YhgTGx47JNIPyR0xw639gg=
-----END PRIVATE KEY-----`;

export interface E2EContext {
  env: Env;
  supabase: MockSupabase;
  github: GitHubMock;
  wsPairs: ReturnType<typeof installMockWebSocketPair>;
  agentConnectionNS: MockDurableObjectNamespace<AgentConnection>;
  taskTimeoutNS: MockDurableObjectNamespace<TaskTimeout>;

  /** Call the Worker's fetch handler directly */
  workerFetch(request: Request): Promise<Response>;

  /** Create a user in the mock DB and return their API key */
  createUser(
    overrides?: Record<string, unknown>,
  ): Promise<{ user: Record<string, unknown>; apiKey: string }>;

  /** Create an agent in the mock DB */
  createAgent(
    userId: string,
    overrides?: Record<string, unknown>,
  ): Promise<Record<string, unknown>>;

  /** Create a project in the mock DB */
  createProject(overrides?: Record<string, unknown>): Promise<Record<string, unknown>>;

  /** Compute HMAC-SHA256 signature for webhook payloads */
  signWebhook(body: string): Promise<string>;

  /** Build an authenticated request */
  authedRequest(path: string, apiKey: string, init?: RequestInit): Request;

  /** Fire DO alarm */
  fireAgentAlarm(agentId: string): Promise<void>;
  fireTimeoutAlarm(taskId: string): Promise<void>;

  /** Simulate an agent WebSocket message to its DO */
  simulateAgentMessage(agentId: string, message: unknown): Promise<void>;

  /** Get last WebSocket pair created */
  getLastWSPair(): MockWebSocketPair | undefined;

  /** Cleanup */
  cleanup(): void;
}

export function createE2EContext(githubOptions?: GitHubMockOptions): E2EContext {
  const supabase = createMockSupabase();
  const github = createGitHubMock(githubOptions);
  const wsPairs = installMockWebSocketPair();
  const fetchInterceptor = installGitHubFetchInterceptor(github);

  // Create env — DO namespaces will be set after creation
  const env: Env = {
    GITHUB_WEBHOOK_SECRET: WEBHOOK_SECRET,
    GITHUB_APP_ID: 'test-app-id',
    GITHUB_APP_PRIVATE_KEY: TEST_RSA_PRIVATE_KEY,
    GITHUB_CLIENT_ID: 'test-client-id',
    GITHUB_CLIENT_SECRET: 'test-client-secret',
    GITHUB_CLI_CLIENT_ID: 'test-cli-client-id',
    GITHUB_CLI_CLIENT_SECRET: 'test-cli-client-secret',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    WEB_URL: 'https://opencara.dev',
    WORKER_URL: 'https://api.opencara.dev',
    AGENT_CONNECTION: null as unknown as DurableObjectNamespace,
    TASK_TIMEOUT: null as unknown as DurableObjectNamespace,
  };

  const agentConnectionNS = new MockDurableObjectNamespace<AgentConnection>(
    AgentConnection as unknown as new (...args: unknown[]) => AgentConnection,
    env,
  );
  const taskTimeoutNS = new MockDurableObjectNamespace<TaskTimeout>(
    TaskTimeout as unknown as new (...args: unknown[]) => TaskTimeout,
    env,
  );

  // Wire up DO namespaces
  env.AGENT_CONNECTION = agentConnectionNS as unknown as DurableObjectNamespace;
  env.TASK_TIMEOUT = taskTimeoutNS as unknown as DurableObjectNamespace;

  const ctx: E2EContext = {
    env,
    supabase,
    github,
    wsPairs,
    agentConnectionNS,
    taskTimeoutNS,

    async workerFetch(request: Request): Promise<Response> {
      return worker.fetch(request, env);
    },

    async createUser(overrides?: Record<string, unknown>) {
      const apiKey = await generateApiKey();
      const apiKeyHash = await hashApiKey(apiKey);
      const user: Record<string, unknown> = {
        id: crypto.randomUUID(),
        github_id: Math.floor(Math.random() * 1000000),
        name: 'testuser',
        avatar: 'https://example.com/avatar.png',
        api_key_hash: apiKeyHash,
        reputation_score: 0.5,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        ...overrides,
      };
      supabase.getTable('users').push(user);
      return { user, apiKey };
    },

    async createAgent(userId: string, overrides?: Record<string, unknown>) {
      const agent: Record<string, unknown> = {
        id: crypto.randomUUID(),
        user_id: userId,
        model: 'claude-sonnet-4-6',
        tool: 'claude-code',
        reputation_score: 0.5,
        status: 'offline',
        last_heartbeat_at: null,
        created_at: new Date().toISOString(),
        ...overrides,
      };
      supabase.getTable('agents').push(agent);
      return agent;
    },

    async createProject(overrides?: Record<string, unknown>) {
      const project: Record<string, unknown> = {
        id: crypto.randomUUID(),
        github_installation_id: 12345,
        owner: 'test-owner',
        repo: 'test-repo',
        created_at: new Date().toISOString(),
        ...overrides,
      };
      supabase.getTable('projects').push(project);
      return project;
    },

    async signWebhook(body: string): Promise<string> {
      const enc = new TextEncoder();
      const key = await crypto.subtle.importKey(
        'raw',
        enc.encode(WEBHOOK_SECRET),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const mac = await crypto.subtle.sign('HMAC', key, enc.encode(body));
      const hex = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');
      return `sha256=${hex}`;
    },

    authedRequest(path: string, apiKey: string, init?: RequestInit): Request {
      const url = `https://api.opencara.dev${path}`;
      return new Request(url, {
        ...init,
        headers: {
          ...Object.fromEntries(new Headers(init?.headers).entries()),
          Authorization: `Bearer ${apiKey}`,
        },
      });
    },

    async fireAgentAlarm(agentId: string) {
      await agentConnectionNS.fireAlarm(agentId);
    },

    async fireTimeoutAlarm(taskId: string) {
      await taskTimeoutNS.fireAlarm(taskId);
    },

    async simulateAgentMessage(agentId: string, message: unknown) {
      const instance = agentConnectionNS.getInstance(agentId);
      if (!instance) throw new Error(`No AgentConnection DO for agent ${agentId}`);
      const state = agentConnectionNS.getState(agentId);
      const websockets = state?.getWebSockets() ?? [];
      if (websockets.length === 0) throw new Error(`No WebSocket for agent ${agentId}`);
      // Call the DO's webSocketMessage handler directly
      await (
        instance as unknown as { webSocketMessage(ws: unknown, msg: string): Promise<void> }
      ).webSocketMessage(websockets[0], JSON.stringify(message));
    },

    getLastWSPair() {
      return wsPairs.getLastPair();
    },

    cleanup() {
      fetchInterceptor.restore();
      wsPairs.reset();
      supabase.reset();
      github.reset();
      agentConnectionNS.reset();
      taskTimeoutNS.reset();
    },
  };

  return ctx;
}
