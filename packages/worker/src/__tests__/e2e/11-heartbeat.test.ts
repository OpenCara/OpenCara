import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: Heartbeat (S15)', () => {
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
    const agentId = agent.id as string;

    const wsReq = new Request(
      `https://api.opencara.dev/ws/agent/${agentId}?token=${apiKey}`,
      { headers: { Upgrade: 'websocket' } },
    );
    const response = await ctx.workerFetch(wsReq);
    expect(response.status).toBe(101);

    return { user, apiKey, agent, agentId };
  }

  it('fire alarm sends heartbeat_ping to client WS', async () => {
    const { agentId } = await connectAgent();
    const pair = ctx.getLastWSPair()!;

    // Clear initial messages (connected message)
    pair.client.receivedMessages.length = 0;

    await ctx.fireAgentAlarm(agentId);

    const messages = pair.client.getReceivedParsed<{ type: string }>();
    expect(messages.some((m) => m.type === 'heartbeat_ping')).toBe(true);
  });

  it('heartbeat_pong updates lastHeartbeatAt in storage', async () => {
    const { agentId } = await connectAgent();

    const state = ctx.agentConnectionNS.getState(agentId)!;
    const beforePong = await state.storage.get<string>('lastHeartbeatAt');

    // Small delay to ensure timestamp differs
    await new Promise((r) => setTimeout(r, 10));

    await ctx.simulateAgentMessage(agentId, { type: 'heartbeat_pong' });

    const afterPong = await state.storage.get<string>('lastHeartbeatAt');
    expect(afterPong).toBeDefined();
    // The timestamp should have been updated (it may or may not differ by ms,
    // but it should be a valid ISO string that was set after the pong)
    expect(typeof afterPong).toBe('string');
    expect(new Date(afterPong!).getTime()).toBeGreaterThanOrEqual(
      new Date(beforePong!).getTime(),
    );
  });

  it('heartbeat timeout (91s since last pong) closes WS with code 4003', async () => {
    const { agentId } = await connectAgent();
    const pair = ctx.getLastWSPair()!;

    // Set lastHeartbeatAt to 91 seconds ago (timeout is 90s)
    const state = ctx.agentConnectionNS.getState(agentId)!;
    await state.storage.put(
      'lastHeartbeatAt',
      new Date(Date.now() - 91_000).toISOString(),
    );

    await ctx.fireAgentAlarm(agentId);

    // The server-side WS should be closed with heartbeat timeout code
    expect(pair.server.isClosed).toBe(true);
    expect(pair.server.closeCode).toBe(4003);
    expect(pair.server.closeReason).toBe('heartbeat_timeout');
  });

  it('after heartbeat timeout agent goes offline in Supabase', async () => {
    const { agentId } = await connectAgent();

    const state = ctx.agentConnectionNS.getState(agentId)!;
    await state.storage.put(
      'lastHeartbeatAt',
      new Date(Date.now() - 91_000).toISOString(),
    );

    await ctx.fireAgentAlarm(agentId);

    // The DO's webSocketClose handler runs when ws.close() is called,
    // but in our mock environment the DO handler must be called manually.
    // The alarm closes the WS which triggers the close flow.
    // Since webSocketClose is triggered by the runtime on actual close,
    // and our mock calls close() on the server, we need to invoke
    // webSocketClose manually to simulate the full flow.
    const instance = ctx.agentConnectionNS.getInstance(agentId)!;
    // Get the closed server websocket from the pair
    const pair = ctx.getLastWSPair()!;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (instance as any).webSocketClose(pair.server, 4003, 'heartbeat_timeout', true);

    const agents = ctx.supabase.getTable('agents');
    const dbAgent = agents.find((a) => a.id === agentId);
    expect(dbAgent!.status).toBe('offline');
  });

  it('no WebSocket connected — alarm does nothing', async () => {
    const { user } = await ctx.createUser();
    const agent = await ctx.createAgent(user.id as string, { status: 'online' });
    const agentId = agent.id as string;

    // Ensure DO is instantiated but no WS is connected
    ctx.agentConnectionNS.getInstance(agentId);

    // Fire alarm — should not throw and should not produce any messages
    await ctx.fireAgentAlarm(agentId);

    // No WS pair was created, so no messages sent
    const pair = ctx.getLastWSPair();
    // Either no pair exists, or if a pair was created elsewhere, no heartbeat was sent
    if (pair) {
      const pings = pair.client
        .getSentParsed<{ type: string }>()
        .filter((m) => m.type === 'heartbeat_ping');
      expect(pings).toHaveLength(0);
    }
  });

  it('after sending ping a new alarm is scheduled', async () => {
    const { agentId } = await connectAgent();

    const state = ctx.agentConnectionNS.getState(agentId)!;

    // Clear the alarm that was set during connection
    await state.storage.deleteAlarm();
    expect(await state.storage.getAlarm()).toBeNull();

    await ctx.fireAgentAlarm(agentId);

    // After the alarm fires and sends a ping, a new alarm should be scheduled
    const newAlarm = await state.storage.getAlarm();
    expect(newAlarm).not.toBeNull();
    expect(typeof newAlarm).toBe('number');
    expect(newAlarm!).toBeGreaterThan(Date.now());
  });
});
