import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: WebSocket Connection (S14, S16)', () => {
  let ctx: E2EContext;

  beforeEach(() => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(ctx.supabase.client as ReturnType<typeof createSupabaseClient>);
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  async function connectAgent() {
    const { user, apiKey } = await ctx.createUser();
    const agent = await ctx.createAgent(user.id as string, { status: 'online' });
    return { user, apiKey, agent };
  }

  async function wsConnect(agentId: string, apiKey: string) {
    const wsReq = new Request(
      `https://api.opencara.dev/ws/agent/${agentId}?token=${apiKey}`,
      { headers: { Upgrade: 'websocket' } },
    );
    return ctx.workerFetch(wsReq);
  }

  it('WS connect with valid agentId + token returns status 101 and connected message', async () => {
    const { apiKey, agent } = await connectAgent();
    const response = await wsConnect(agent.id as string, apiKey);

    expect(response.status).toBe(101);

    const pair = ctx.getLastWSPair();
    expect(pair).toBeDefined();

    // The server side sends the connected message, which the client captures
    const messages = pair!.client.getReceivedParsed<{ type: string }>();
    expect(messages.some((m) => m.type === 'connected')).toBe(true);
  });

  it('connected message has correct agentId and version=1', async () => {
    const { apiKey, agent } = await connectAgent();
    await wsConnect(agent.id as string, apiKey);

    const pair = ctx.getLastWSPair();
    const connectedMsg = pair!.client.getReceivedParsed<{
      type: string;
      agentId: string;
      version: number;
    }>().find((m) => m.type === 'connected');

    expect(connectedMsg).toBeDefined();
    expect(connectedMsg!.agentId).toBe(agent.id);
    expect(connectedMsg!.version).toBe(1);
  });

  it('DO storage has status=online and connectedAt set after connect', async () => {
    const { apiKey, agent } = await connectAgent();
    await wsConnect(agent.id as string, apiKey);

    const state = ctx.agentConnectionNS.getState(agent.id as string)!;
    const status = await state.storage.get<string>('status');
    const connectedAt = await state.storage.get<string>('connectedAt');

    expect(status).toBe('online');
    expect(connectedAt).toBeDefined();
    expect(typeof connectedAt).toBe('string');
  });

  it('agent status updated to online in Supabase after connect', async () => {
    const { apiKey, agent } = await connectAgent();
    await wsConnect(agent.id as string, apiKey);

    const agents = ctx.supabase.getTable('agents');
    const dbAgent = agents.find((a) => a.id === agent.id);
    expect(dbAgent).toBeDefined();
    expect(dbAgent!.status).toBe('online');
  });

  it('DO /status endpoint returns online after connect', async () => {
    const { apiKey, agent } = await connectAgent();
    await wsConnect(agent.id as string, apiKey);

    const doId = ctx.agentConnectionNS.idFromName(agent.id as string);
    const stub = ctx.agentConnectionNS.get(doId);
    const statusRes = await stub.fetch(new Request('https://internal/status'));
    const body = (await statusRes.json()) as { status: string };

    expect(body.status).toBe('online');
  });

  it('request without Upgrade header returns 426', async () => {
    const { apiKey, agent } = await connectAgent();

    const req = new Request(
      `https://api.opencara.dev/ws/agent/${agent.id}?token=${apiKey}`,
      // No Upgrade header
    );
    const response = await ctx.workerFetch(req);

    expect(response.status).toBe(426);
  });

  it('invalid token returns 401', async () => {
    const { agent } = await connectAgent();

    const wsReq = new Request(
      `https://api.opencara.dev/ws/agent/${agent.id}?token=invalid-token-12345`,
      { headers: { Upgrade: 'websocket' } },
    );
    const response = await ctx.workerFetch(wsReq);

    expect(response.status).toBe(401);
  });

  it('non-existent agentId returns 404', async () => {
    const { apiKey } = await connectAgent();

    const wsReq = new Request(
      `https://api.opencara.dev/ws/agent/non-existent-agent-id?token=${apiKey}`,
      { headers: { Upgrade: 'websocket' } },
    );
    const response = await ctx.workerFetch(wsReq);

    expect(response.status).toBe(404);
  });

  it('second connection replaces first with close code 4002', async () => {
    const { apiKey, agent } = await connectAgent();
    const agentId = agent.id as string;

    // First connection
    await wsConnect(agentId, apiKey);
    const firstPair = ctx.getLastWSPair()!;

    // Advance time past debounce window (5 seconds)
    const state = ctx.agentConnectionNS.getState(agentId)!;
    await state.storage.put('connectedAt', new Date(Date.now() - 6_000).toISOString());

    // Second connection — should replace the first
    await wsConnect(agentId, apiKey);

    // The first connection's server should be closed with code 4002
    expect(firstPair.server.isClosed).toBe(true);
    expect(firstPair.server.closeCode).toBe(4002);
    expect(firstPair.server.closeReason).toBe('replaced');
  });

  it('rapid reconnect within 5s returns 409', async () => {
    const { apiKey, agent } = await connectAgent();
    const agentId = agent.id as string;

    // First connection
    const firstRes = await wsConnect(agentId, apiKey);
    expect(firstRes.status).toBe(101);

    // Immediate second connection (within debounce window)
    const secondRes = await wsConnect(agentId, apiKey);
    expect(secondRes.status).toBe(409);
  });
});
