import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createE2EContext, type E2EContext } from './helpers/mock-env.js';
import { createSupabaseClient } from '../../db.js';

vi.mock('../../db.js', () => ({
  createSupabaseClient: vi.fn(),
}));

describe('E2E: WebSocket Disconnect', () => {
  let ctx: E2EContext;

  beforeEach(() => {
    ctx = createE2EContext();
    vi.mocked(createSupabaseClient).mockReturnValue(
      ctx.supabase.client as ReturnType<typeof createSupabaseClient>,
    );
  });

  afterEach(() => {
    ctx.cleanup();
    vi.restoreAllMocks();
  });

  async function connectAgent() {
    const { user, apiKey } = await ctx.createUser();
    const agent = await ctx.createAgent(user.id as string, { status: 'online' });
    const agentId = agent.id as string;

    const wsReq = new Request(`https://api.opencara.dev/ws/agent/${agentId}?token=${apiKey}`, {
      headers: { Upgrade: 'websocket' },
    });
    const response = await ctx.workerFetch(wsReq);
    expect(response.status).toBe(101);

    return { user, apiKey, agent, agentId };
  }

  it('clean WS close sets agent status=offline in Supabase', async () => {
    const { agentId } = await connectAgent();

    const instance = ctx.agentConnectionNS.getInstance(agentId)!;
    const state = ctx.agentConnectionNS.getState(agentId)!;
    const ws = state.getWebSockets()[0];

    await (
      instance as unknown as Record<string, (...args: unknown[]) => Promise<void>>
    ).webSocketClose(ws, 1000, 'normal', true);

    const agents = ctx.supabase.getTable('agents');
    const dbAgent = agents.find((a) => a.id === agentId);
    expect(dbAgent).toBeDefined();
    expect(dbAgent!.status).toBe('offline');
  });

  it('in-flight tasks get error results in review_results table on disconnect', async () => {
    const { agentId } = await connectAgent();

    const state = ctx.agentConnectionNS.getState(agentId)!;

    // Simulate in-flight tasks
    await state.storage.put('inFlightTaskIds', ['task-1']);
    await state.storage.put('agentId', agentId);

    const instance = ctx.agentConnectionNS.getInstance(agentId)!;
    const ws = state.getWebSockets()[0];

    await (
      instance as unknown as Record<string, (...args: unknown[]) => Promise<void>>
    ).webSocketClose(ws, 1000, 'normal', true);

    // Verify error result was inserted for the in-flight task
    const results = ctx.supabase.getTable('review_results');
    const errorResult = results.find(
      (r) => r.review_task_id === 'task-1' && r.agent_id === agentId,
    );
    expect(errorResult).toBeDefined();
    expect(errorResult!.status).toBe('error');
  });

  it('alarm deleted on disconnect', async () => {
    const { agentId } = await connectAgent();

    const state = ctx.agentConnectionNS.getState(agentId)!;

    // Verify alarm is set after connection
    const alarmBefore = await state.storage.getAlarm();
    expect(alarmBefore).not.toBeNull();

    const instance = ctx.agentConnectionNS.getInstance(agentId)!;
    const ws = state.getWebSockets()[0];

    await (
      instance as unknown as Record<string, (...args: unknown[]) => Promise<void>>
    ).webSocketClose(ws, 1000, 'normal', true);

    // Alarm should be deleted after disconnect
    const alarmAfter = await state.storage.getAlarm();
    expect(alarmAfter).toBeNull();
  });

  it('close with code 4002 (replaced) does NOT set agent offline', async () => {
    const { agentId } = await connectAgent();

    // Ensure agent is online in Supabase
    const agentsBefore = ctx.supabase.getTable('agents');
    const dbAgentBefore = agentsBefore.find((a) => a.id === agentId);
    expect(dbAgentBefore!.status).toBe('online');

    const instance = ctx.agentConnectionNS.getInstance(agentId)!;
    const state = ctx.agentConnectionNS.getState(agentId)!;
    const ws = state.getWebSockets()[0];

    // Close with code 4002 (replaced) — should skip cleanup
    await (
      instance as unknown as Record<string, (...args: unknown[]) => Promise<void>>
    ).webSocketClose(ws, 4002, 'replaced', true);

    // Agent should still be online
    const agentsAfter = ctx.supabase.getTable('agents');
    const dbAgentAfter = agentsAfter.find((a) => a.id === agentId);
    expect(dbAgentAfter!.status).toBe('online');

    // DO storage status should still be online (not changed to offline)
    const status = await state.storage.get<string>('status');
    expect(status).toBe('online');
  });

  it('WebSocket error triggers close with code 4004', async () => {
    const { agentId } = await connectAgent();

    const instance = ctx.agentConnectionNS.getInstance(agentId)!;
    const state = ctx.agentConnectionNS.getState(agentId)!;
    const ws = state.getWebSockets()[0];

    await (
      instance as unknown as Record<string, (...args: unknown[]) => Promise<void>>
    ).webSocketError(ws, new Error('test'));

    // webSocketError calls ws.close(4004, 'websocket_error')
    expect(ws.closeCode).toBe(4004);
    expect(ws.isClosed).toBe(true);
  });
});
