import type {
  ReviewCompleteMessage,
  ReviewRejectedMessage,
  ReviewErrorMessage,
  SummaryCompleteMessage,
  ReviewRequestMessage,
} from '@opencrust/shared';
import { createSupabaseClient } from './db.js';
import type { Env } from './env.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;

export class AgentConnection implements DurableObject {
  private state: DurableObjectState;
  private env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/websocket':
        return this.handleWebSocket(request);
      case '/push-task':
        return this.handlePushTask(request);
      case '/status':
        return this.handleStatus();
      default:
        return new Response('Not found', { status: 404 });
    }
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    // Close existing connection if any
    for (const ws of this.state.getWebSockets()) {
      ws.close(4002, 'replaced');
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    const url = new URL(request.url);
    const agentId = url.searchParams.get('agentId') ?? '';

    this.state.acceptWebSocket(server);

    const now = new Date().toISOString();
    await this.state.storage.put('agentId', agentId);
    await this.state.storage.put('status', 'online');
    await this.state.storage.put('connectedAt', now);
    await this.state.storage.put('lastHeartbeatAt', now);
    await this.state.storage.put('inFlightTaskIds', [] as string[]);

    server.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        type: 'connected',
        version: 1,
        agentId,
      }),
    );

    const supabase = createSupabaseClient(this.env);
    await supabase
      .from('agents')
      .update({ status: 'online', last_heartbeat_at: now })
      .eq('id', agentId);

    await this.state.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(
    _ws: WebSocket,
    message: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof message !== 'string') return;

    let msg: { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'heartbeat_pong':
        await this.state.storage.put(
          'lastHeartbeatAt',
          new Date().toISOString(),
        );
        break;
      case 'review_complete':
        await this.handleReviewComplete(msg as unknown as ReviewCompleteMessage);
        break;
      case 'review_rejected':
        await this.handleReviewRejected(msg as unknown as ReviewRejectedMessage);
        break;
      case 'review_error':
        await this.handleReviewError(msg as unknown as ReviewErrorMessage);
        break;
      case 'summary_complete':
        await this.handleSummaryComplete(msg as unknown as SummaryCompleteMessage);
        break;
    }
  }

  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const agentId = await this.state.storage.get<string>('agentId');

    await this.state.storage.put('status', 'offline');
    await this.state.storage.delete('connectedAt');

    if (agentId) {
      const supabase = createSupabaseClient(this.env);
      await supabase
        .from('agents')
        .update({ status: 'offline' })
        .eq('id', agentId);

      // Mark in-flight tasks as error
      const inFlightTaskIds =
        (await this.state.storage.get<string[]>('inFlightTaskIds')) ?? [];
      for (const taskId of inFlightTaskIds) {
        await supabase.from('review_results').insert({
          review_task_id: taskId,
          agent_id: agentId,
          status: 'error',
        });
      }
      await this.state.storage.put('inFlightTaskIds', [] as string[]);
    }

    await this.state.storage.deleteAlarm();
  }

  async alarm(): Promise<void> {
    const websockets = this.state.getWebSockets();
    if (websockets.length === 0) return;

    const ws = websockets[0];

    // Check if last pong was received within timeout
    const lastPongStr =
      await this.state.storage.get<string>('lastHeartbeatAt');
    if (lastPongStr) {
      const elapsed = Date.now() - new Date(lastPongStr).getTime();
      if (elapsed > HEARTBEAT_TIMEOUT_MS) {
        ws.close(4003, 'heartbeat_timeout');
        return;
      }
    }

    ws.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        type: 'heartbeat_ping',
      }),
    );

    await this.state.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);
  }

  private async handlePushTask(request: Request): Promise<Response> {
    const websockets = this.state.getWebSockets();
    if (websockets.length === 0) {
      return new Response('Agent not connected', { status: 503 });
    }

    const payload = (await request.json()) as {
      taskId: string;
      pr: { url: string; number: number; diffUrl: string; base: string; head: string };
      project: { owner: string; repo: string; prompt: string };
      timeout: number;
    };

    const message: ReviewRequestMessage = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_request',
      taskId: payload.taskId,
      pr: payload.pr,
      project: payload.project,
      timeout: payload.timeout,
    };

    websockets[0].send(JSON.stringify(message));

    const inFlightTaskIds =
      (await this.state.storage.get<string[]>('inFlightTaskIds')) ?? [];
    inFlightTaskIds.push(payload.taskId);
    await this.state.storage.put('inFlightTaskIds', inFlightTaskIds);

    return new Response('OK', { status: 200 });
  }

  private async handleStatus(): Promise<Response> {
    const status =
      (await this.state.storage.get<string>('status')) ?? 'offline';
    const connectedAt =
      await this.state.storage.get<string | null>('connectedAt');
    const lastHeartbeatAt =
      await this.state.storage.get<string | null>('lastHeartbeatAt');
    const inFlightTaskIds =
      (await this.state.storage.get<string[]>('inFlightTaskIds')) ?? [];

    return new Response(
      JSON.stringify({ status, connectedAt, lastHeartbeatAt, inFlightTaskIds }),
      { headers: { 'Content-Type': 'application/json' } },
    );
  }

  private async removeInFlightTask(taskId: string): Promise<void> {
    const inFlightTaskIds =
      (await this.state.storage.get<string[]>('inFlightTaskIds')) ?? [];
    const idx = inFlightTaskIds.indexOf(taskId);
    if (idx !== -1) {
      inFlightTaskIds.splice(idx, 1);
      await this.state.storage.put('inFlightTaskIds', inFlightTaskIds);
    }
  }

  private async handleReviewComplete(
    msg: ReviewCompleteMessage,
  ): Promise<void> {
    await this.removeInFlightTask(msg.taskId);

    const agentId =
      (await this.state.storage.get<string>('agentId')) ?? '';
    const supabase = createSupabaseClient(this.env);

    await supabase.from('review_results').insert({
      review_task_id: msg.taskId,
      agent_id: agentId,
      status: 'completed',
    });

    if (msg.tokensUsed > 0) {
      await supabase.from('consumption_logs').insert({
        agent_id: agentId,
        review_task_id: msg.taskId,
        tokens_used: msg.tokensUsed,
      });
    }
  }

  private async handleReviewRejected(
    msg: ReviewRejectedMessage,
  ): Promise<void> {
    await this.removeInFlightTask(msg.taskId);

    const agentId =
      (await this.state.storage.get<string>('agentId')) ?? '';
    const supabase = createSupabaseClient(this.env);

    await supabase.from('review_results').insert({
      review_task_id: msg.taskId,
      agent_id: agentId,
      status: 'rejected',
    });
  }

  private async handleReviewError(
    msg: ReviewErrorMessage,
  ): Promise<void> {
    await this.removeInFlightTask(msg.taskId);

    const agentId =
      (await this.state.storage.get<string>('agentId')) ?? '';
    const supabase = createSupabaseClient(this.env);

    await supabase.from('review_results').insert({
      review_task_id: msg.taskId,
      agent_id: agentId,
      status: 'error',
    });
  }

  private async handleSummaryComplete(
    msg: SummaryCompleteMessage,
  ): Promise<void> {
    // Summary handling will be implemented in M6
    console.log(`Summary complete for task ${msg.taskId}`);
  }
}
