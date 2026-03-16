import type {
  ReviewCompleteMessage,
  ReviewRejectedMessage,
  ReviewErrorMessage,
  SummaryCompleteMessage,
  ReviewRequestMessage,
  ReviewVerdict,
} from '@opencrust/shared';
import { createSupabaseClient } from './db.js';
import type { Env } from './env.js';
import { getInstallationToken, postPrComment } from './github.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;
const MAX_REVIEW_ATTEMPTS = 3;

const VERDICT_LABELS: Record<ReviewVerdict, string> = {
  approve: '\u2705 Approve',
  request_changes: '\u274C Changes Requested',
  comment: '\uD83D\uDCAC Comment',
};

export function formatReviewComment(
  verdict: ReviewVerdict,
  model: string,
  tool: string,
  review: string,
): string {
  const verdictLabel = VERDICT_LABELS[verdict];
  return [
    '## \uD83D\uDD0D OpenCrust Review',
    '',
    `**Verdict**: ${verdictLabel}`,
    `**Agent**: \`${model}\` / \`${tool}\``,
    '',
    '---',
    '',
    review,
    '',
    '---',
    '<sub>Reviewed by <a href="https://github.com/user/opencrust">OpenCrust</a> | React with \uD83D\uDC4D or \uD83D\uDC4E to rate this review</sub>',
  ].join('\n');
}

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

  async webSocketMessage(_ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    if (typeof message !== 'string') return;

    let msg: { type: string; [key: string]: unknown };
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }

    switch (msg.type) {
      case 'heartbeat_pong':
        await this.state.storage.put('lastHeartbeatAt', new Date().toISOString());
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

  async webSocketError(ws: WebSocket, _error: unknown): Promise<void> {
    ws.close(4004, 'websocket_error');
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
      await supabase.from('agents').update({ status: 'offline' }).eq('id', agentId);

      // Mark in-flight tasks as error
      const inFlightTaskIds = (await this.state.storage.get<string[]>('inFlightTaskIds')) ?? [];
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
    const lastPongStr = await this.state.storage.get<string>('lastHeartbeatAt');
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
      diffContent: string;
    };

    const message: ReviewRequestMessage = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_request',
      taskId: payload.taskId,
      pr: payload.pr,
      project: payload.project,
      timeout: payload.timeout,
      diffContent: payload.diffContent,
    };

    websockets[0].send(JSON.stringify(message));

    const inFlightTaskIds = (await this.state.storage.get<string[]>('inFlightTaskIds')) ?? [];
    inFlightTaskIds.push(payload.taskId);
    await this.state.storage.put('inFlightTaskIds', inFlightTaskIds);

    return new Response('OK', { status: 200 });
  }

  private async handleStatus(): Promise<Response> {
    const status = (await this.state.storage.get<string>('status')) ?? 'offline';
    const connectedAt = await this.state.storage.get<string | null>('connectedAt');
    const lastHeartbeatAt = await this.state.storage.get<string | null>('lastHeartbeatAt');
    const inFlightTaskIds = (await this.state.storage.get<string[]>('inFlightTaskIds')) ?? [];

    return new Response(JSON.stringify({ status, connectedAt, lastHeartbeatAt, inFlightTaskIds }), {
      headers: { 'Content-Type': 'application/json' },
    });
  }

  private async removeInFlightTask(taskId: string): Promise<void> {
    const inFlightTaskIds = (await this.state.storage.get<string[]>('inFlightTaskIds')) ?? [];
    const idx = inFlightTaskIds.indexOf(taskId);
    if (idx !== -1) {
      inFlightTaskIds.splice(idx, 1);
      await this.state.storage.put('inFlightTaskIds', inFlightTaskIds);
    }
  }

  private async handleReviewComplete(msg: ReviewCompleteMessage): Promise<void> {
    const agentId = (await this.state.storage.get<string>('agentId')) ?? '';
    const supabase = createSupabaseClient(this.env);

    // Insert result before removing from in-flight for crash safety
    const { error } = await supabase.from('review_results').insert({
      review_task_id: msg.taskId,
      agent_id: agentId,
      status: 'completed',
    });
    if (error) {
      console.error(`Failed to insert review result for task ${msg.taskId}:`, error);
    }

    await this.removeInFlightTask(msg.taskId);

    if (msg.tokensUsed > 0) {
      const { error: logError } = await supabase.from('consumption_logs').insert({
        agent_id: agentId,
        review_task_id: msg.taskId,
        tokens_used: msg.tokensUsed,
      });
      if (logError) {
        console.error(`Failed to insert consumption log for task ${msg.taskId}:`, logError);
      }
    }

    // Look up task + project info for posting the review
    const { data: taskData } = await supabase
      .from('review_tasks')
      .select('pr_number, pr_url, project_id, projects!inner(owner, repo, github_installation_id)')
      .eq('id', msg.taskId)
      .single();

    if (!taskData) {
      console.error(`Task ${msg.taskId} not found for review posting`);
      return;
    }

    const project = taskData.projects as unknown as {
      owner: string;
      repo: string;
      github_installation_id: number;
    };

    // Look up agent model/tool for comment formatting
    const { data: agentData } = await supabase
      .from('agents')
      .select('model, tool')
      .eq('id', agentId)
      .single();

    const model = agentData?.model ?? 'unknown';
    const tool = agentData?.tool ?? 'unknown';

    // Format and post the review as a PR comment
    const formattedReview = formatReviewComment(msg.verdict, model, tool, msg.review);

    try {
      const installationToken = await getInstallationToken(
        project.github_installation_id,
        this.env,
      );
      const commentUrl = await postPrComment(
        project.owner,
        project.repo,
        taskData.pr_number as number,
        formattedReview,
        installationToken,
      );

      // Update review_results with comment_url
      await supabase
        .from('review_results')
        .update({ comment_url: commentUrl })
        .eq('review_task_id', msg.taskId)
        .eq('agent_id', agentId);

      // Transition task to completed
      await supabase
        .from('review_tasks')
        .update({ status: 'completed' })
        .eq('id', msg.taskId)
        .eq('status', 'reviewing');
    } catch (err) {
      console.error(`Failed to post review for task ${msg.taskId}:`, err);
    }
  }

  private async handleReviewRejected(msg: ReviewRejectedMessage): Promise<void> {
    const agentId = (await this.state.storage.get<string>('agentId')) ?? '';
    const supabase = createSupabaseClient(this.env);

    // Insert result before removing from in-flight for crash safety
    const { error } = await supabase.from('review_results').insert({
      review_task_id: msg.taskId,
      agent_id: agentId,
      status: 'rejected',
    });
    if (error) {
      console.error(`Failed to insert review result for task ${msg.taskId}:`, error);
    }

    await this.removeInFlightTask(msg.taskId);
    await this.redistributeTask(msg.taskId, supabase);
  }

  private async handleReviewError(msg: ReviewErrorMessage): Promise<void> {
    const agentId = (await this.state.storage.get<string>('agentId')) ?? '';
    const supabase = createSupabaseClient(this.env);

    // Insert result before removing from in-flight for crash safety
    const { error } = await supabase.from('review_results').insert({
      review_task_id: msg.taskId,
      agent_id: agentId,
      status: 'error',
    });
    if (error) {
      console.error(`Failed to insert review result for task ${msg.taskId}:`, error);
    }

    await this.removeInFlightTask(msg.taskId);
    await this.redistributeTask(msg.taskId, supabase);
  }

  private async redistributeTask(
    taskId: string,
    supabase: ReturnType<typeof createSupabaseClient>,
  ): Promise<void> {
    // Count total attempts for this task
    const { count } = await supabase
      .from('review_results')
      .select('id', { count: 'exact', head: true })
      .eq('review_task_id', taskId);

    if ((count ?? 0) >= MAX_REVIEW_ATTEMPTS) {
      // Max attempts reached, fail the task
      await supabase.from('review_tasks').update({ status: 'failed' }).eq('id', taskId);
      console.log(`Task ${taskId} failed after ${count} attempts`);
      return;
    }

    // Get agents that already attempted this task
    const { data: previousAttempts } = await supabase
      .from('review_results')
      .select('agent_id')
      .eq('review_task_id', taskId);

    const excludedAgentIds = (previousAttempts ?? []).map((r: { agent_id: string }) => r.agent_id);

    // Find another eligible online agent with reputation >= 0
    const { data: candidates } = await supabase
      .from('agents')
      .select('id')
      .eq('status', 'online')
      .gte('reputation_score', 0);

    const eligible = (candidates ?? []).filter(
      (a: { id: string }) => !excludedAgentIds.includes(a.id),
    );

    if (eligible.length === 0) {
      await supabase.from('review_tasks').update({ status: 'failed' }).eq('id', taskId);
      console.log(`Task ${taskId} failed: no eligible agents remaining`);
      return;
    }

    // Look up task info for redistribution
    const { data: taskData } = await supabase
      .from('review_tasks')
      .select('pr_number, pr_url, timeout_at, projects!inner(owner, repo, github_installation_id)')
      .eq('id', taskId)
      .single();

    if (!taskData) {
      console.error(`Task ${taskId} not found for redistribution`);
      return;
    }

    const project = taskData.projects as unknown as {
      owner: string;
      repo: string;
      github_installation_id: number;
    };

    const timeoutAt = new Date(taskData.timeout_at as string).getTime();
    const remainingSeconds = Math.max(0, Math.floor((timeoutAt - Date.now()) / 1000));

    // Push task to the next eligible agent's DO
    const nextAgentId = (eligible[0] as { id: string }).id;
    try {
      const doId = this.env.AGENT_CONNECTION.idFromName(nextAgentId);
      const stub = this.env.AGENT_CONNECTION.get(doId);
      await stub.fetch(
        new Request('https://internal/push-task', {
          method: 'POST',
          body: JSON.stringify({
            taskId,
            pr: {
              url: taskData.pr_url,
              number: taskData.pr_number,
              diffUrl: `https://github.com/${project.owner}/${project.repo}/pull/${taskData.pr_number}.diff`,
              base: 'main',
              head: 'unknown',
            },
            project: { owner: project.owner, repo: project.repo, prompt: '' },
            timeout: remainingSeconds,
            diffContent: '',
          }),
        }),
      );
      console.log(`Task ${taskId} redistributed to agent ${nextAgentId}`);
    } catch (err) {
      console.error(`Failed to redistribute task ${taskId} to agent ${nextAgentId}:`, err);
    }
  }

  private async handleSummaryComplete(msg: SummaryCompleteMessage): Promise<void> {
    // Summary handling will be implemented in M6
    console.log(`Summary complete for task ${msg.taskId}`);
  }
}
