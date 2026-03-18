import type {
  AgentPreferencesMessage,
  ReviewCompleteMessage,
  ReviewRejectedMessage,
  ReviewErrorMessage,
  SummaryCompleteMessage,
  SummaryRequestMessage,
  ReviewRequestMessage,
  ReviewVerdict,
} from '@opencara/shared';
import { createSupabaseClient } from './db.js';
import type { Env } from './env.js';
import { getInstallationToken, fetchPrDiff, postPrReview, verdictToReviewEvent } from './github.js';
import { parseStructuredReview, parseDiffFiles, filterValidComments } from './review-parser.js';
import {
  type InFlightTaskMeta,
  triggerSummarization,
  formatSummaryComment,
  postIndividualReviewsFallback,
  fetchCompletedReviews,
  fetchReviewContributors,
} from './summarization.js';
import { filterByRepoConfig, isValidRepoConfig, type EligibleAgent } from './task-distribution.js';

const HEARTBEAT_INTERVAL_MS = 30_000;
const HEARTBEAT_TIMEOUT_MS = 90_000;
const MAX_REVIEW_ATTEMPTS = 3;
const MIN_REMAINING_SECONDS_FOR_PICKUP = 30;
const CONNECT_DEBOUNCE_MS = 5_000;

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
  contributorName?: string,
): string {
  const verdictLabel = VERDICT_LABELS[verdict];
  const contributorLine = contributorName
    ? `**Contributor**: [@${contributorName}](https://github.com/${contributorName})`
    : '';
  return [
    '## \uD83D\uDD0D OpenCara Review',
    '',
    `**Verdict**: ${verdictLabel}`,
    `**Agent**: \`${model}\` / \`${tool}\``,
    ...(contributorLine ? [contributorLine] : []),
    '',
    '---',
    '',
    review,
    '',
    '---',
    '<sub>Reviewed by <a href="https://github.com/apps/opencara">OpenCara</a> | React with \uD83D\uDC4D or \uD83D\uDC4E to rate this review</sub>',
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
      case '/push-summary':
        return this.handlePushSummary(request);
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

    // Debounce: if connected recently and WebSocket is still alive, reject
    const existingWebSockets = this.state.getWebSockets();
    const lastConnectedAt = await this.state.storage.get<string>('connectedAt');
    if (lastConnectedAt && existingWebSockets.length > 0) {
      const elapsed = Date.now() - new Date(lastConnectedAt).getTime();
      if (isNaN(elapsed) || elapsed < CONNECT_DEBOUNCE_MS) {
        return new Response('Already connected', { status: 409 });
      }
    }

    const isReconnect = existingWebSockets.length > 0;

    // Close existing connection if any
    for (const ws of existingWebSockets) {
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

    // On fresh connections, clear in-flight tasks. On reconnects, check if
    // there are actually in-flight tasks — if not, treat it as fresh.
    const existingInFlight = isReconnect
      ? ((await this.state.storage.get<string[]>('inFlightTaskIds')) ?? [])
      : [];
    const hasInFlightTasks = existingInFlight.length > 0;

    if (!hasInFlightTasks) {
      await this.state.storage.put('inFlightTaskIds', [] as string[]);
    }

    console.log(
      `WebSocket ${isReconnect ? 'reconnect' : 'connect'} for agent ${agentId}` +
        (isReconnect ? ` (${existingInFlight.length} in-flight tasks)` : ''),
    );

    server.send(
      JSON.stringify({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        type: 'connected',
        version: 1,
        agentId,
      }),
    );

    let supabase: ReturnType<typeof createSupabaseClient> | undefined;
    try {
      supabase = createSupabaseClient(this.env);
      await supabase
        .from('agents')
        .update({ status: 'online', last_heartbeat_at: now })
        .eq('id', agentId);
    } catch (err) {
      console.error(`Failed to update agent ${agentId} status on connect:`, err);
    }

    await this.state.storage.setAlarm(Date.now() + HEARTBEAT_INTERVAL_MS);

    // Pick up pending tasks on fresh connections OR when reconnecting with
    // no in-flight tasks (the previous connection's tasks were lost).
    if (supabase && !hasInFlightTasks) {
      try {
        await this.pickUpPendingTasks(agentId, supabase);
      } catch (err) {
        console.error(`Failed to pick up pending tasks for agent ${agentId} on connect:`, err);
      }
    }

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
      case 'agent_preferences':
        await this.handleAgentPreferences(msg as unknown as AgentPreferencesMessage);
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
    code: number,
    reason: string,
    _wasClean: boolean,
  ): Promise<void> {
    const agentId = await this.state.storage.get<string>('agentId');
    console.log(
      `WebSocket closed for agent ${agentId ?? 'unknown'}: code=${code}, reason=${reason}`,
    );

    // Skip cleanup for replaced connections (code 4002) — the new connection
    // already set the correct state (connectedAt, status, alarm).
    if (code === 4002) return;

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

  private async pickUpPendingTasks(
    agentId: string,
    supabase: ReturnType<typeof createSupabaseClient>,
  ): Promise<void> {
    // Look up agent's repo preferences for filtering
    const { data: agentData } = await supabase
      .from('agents')
      .select('repo_config, users!inner(name)')
      .eq('id', agentId)
      .single();

    const agentRepoConfig = (agentData?.repo_config as EligibleAgent['repoConfig']) ?? null;
    const agentUserName =
      ((agentData?.users as unknown as Record<string, unknown>)?.name as string) ?? '';

    // Query review_tasks with status='pending' that haven't expired
    const { data: pendingTasks } = await supabase
      .from('review_tasks')
      .select(
        'id, pr_number, pr_url, timeout_at, config_json, project_id, projects!inner(owner, repo, github_installation_id)',
      )
      .eq('status', 'pending')
      .gt('timeout_at', new Date().toISOString())
      .order('created_at', { ascending: true });

    if (!pendingTasks || pendingTasks.length === 0) return;

    for (const task of pendingTasks) {
      // Check WebSocket availability BEFORE CAS update to avoid orphaning tasks
      const websockets = this.state.getWebSockets();
      if (websockets.length === 0) break;

      const timeoutAt = new Date(task.timeout_at as string).getTime();
      const remainingSeconds = Math.max(0, Math.floor((timeoutAt - Date.now()) / 1000));

      if (remainingSeconds <= MIN_REMAINING_SECONDS_FOR_PICKUP) continue;

      // Check repo config filter before claiming the task
      const project = task.projects as unknown as {
        owner: string;
        repo: string;
        github_installation_id: number;
      };

      const dummyAgent: EligibleAgent = {
        id: agentId,
        userId: '',
        userName: agentUserName,
        model: '',
        tool: '',
        reputationScore: 0,
        repoConfig: agentRepoConfig,
      };
      if (filterByRepoConfig([dummyAgent], project.owner, project.repo).length === 0) continue;

      // CAS transition: pending -> reviewing (prevents race with other agents)
      const { error } = await supabase
        .from('review_tasks')
        .update({ status: 'reviewing' })
        .eq('id', task.id)
        .eq('status', 'pending');

      if (error) continue; // Another agent got it first
      const config = (task.config_json as Record<string, unknown>) ?? {};
      const installationId = (config.installationId as number) ?? project.github_installation_id;

      // Fetch diff from GitHub API (not stored in DB)
      let diffContent: string;
      try {
        const token = await getInstallationToken(installationId, this.env);
        diffContent = await fetchPrDiff(
          project.owner,
          project.repo,
          task.pr_number as number,
          token,
        );
      } catch (err) {
        console.error(`Failed to fetch diff for task ${task.id}, reverting to pending:`, err);
        await supabase
          .from('review_tasks')
          .update({ status: 'pending' })
          .eq('id', task.id)
          .eq('status', 'reviewing');
        continue;
      }

      try {
        const message: ReviewRequestMessage = {
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          type: 'review_request',
          taskId: task.id as string,
          pr: {
            url: task.pr_url as string,
            number: task.pr_number as number,
            diffUrl:
              (config.diffUrl as string) ??
              `https://github.com/${project.owner}/${project.repo}/pull/${task.pr_number}.diff`,
            base: (config.baseRef as string) ?? 'main',
            head: (config.headRef as string) ?? 'unknown',
          },
          project: {
            owner: project.owner,
            repo: project.repo,
            prompt: (config.prompt as string) ?? '',
          },
          timeout: remainingSeconds,
          diffContent,
          reviewMode: ((config.reviewCount as number) ?? 1) > 1 ? 'compact' : 'full',
        };

        websockets[0].send(JSON.stringify(message));

        const inFlightTaskIds = (await this.state.storage.get<string[]>('inFlightTaskIds')) ?? [];
        inFlightTaskIds.push(task.id as string);
        await this.state.storage.put('inFlightTaskIds', inFlightTaskIds);

        // Store per-task metadata for multi-agent review collection
        const reviewCount = (config.reviewCount as number) ?? 1;
        const taskMeta: InFlightTaskMeta = {
          reviewCount,
          installationId: (config.installationId as number) ?? project.github_installation_id,
          owner: project.owner,
          repo: project.repo,
          prNumber: task.pr_number as number,
          prompt: (config.prompt as string) ?? '',
        };
        await this.state.storage.put(`taskMeta:${task.id}`, taskMeta);

        console.log(
          `Pending task ${task.id} picked up by agent ${agentId} (${remainingSeconds}s remaining)`,
        );
      } catch (err) {
        // Rollback: revert task to pending so another agent or timeout can handle it
        await supabase
          .from('review_tasks')
          .update({ status: 'pending' })
          .eq('id', task.id)
          .eq('status', 'reviewing');
        console.error(
          `Failed to send task ${task.id} to agent ${agentId}, reverted to pending:`,
          err,
        );
        break; // WebSocket likely broken, stop processing
      }
    }
  }

  private async handleAgentPreferences(msg: AgentPreferencesMessage): Promise<void> {
    const agentId = (await this.state.storage.get<string>('agentId')) ?? '';
    if (!agentId) return;

    if (!isValidRepoConfig(msg.repoConfig)) {
      console.warn(`Invalid repoConfig from agent ${agentId}:`, msg.repoConfig);
      this.sendError(4100, 'Invalid repoConfig: must have a valid mode and optional string[] list');
      return;
    }

    const supabase = createSupabaseClient(this.env);
    const { error } = await supabase
      .from('agents')
      .update({ repo_config: msg.repoConfig })
      .eq('id', agentId);

    if (error) {
      console.error(`Failed to update repo_config for agent ${agentId}:`, error);
      this.sendError(5000, 'Failed to save repo preferences');
    } else {
      console.log(`Updated repo_config for agent ${agentId}: mode=${msg.repoConfig.mode}`);
    }
  }

  private sendError(code: number, message: string): void {
    const websockets = this.state.getWebSockets();
    if (websockets.length === 0) return;
    websockets[0].send(
      JSON.stringify({
        id: crypto.randomUUID(),
        timestamp: Date.now(),
        type: 'error',
        code,
        message,
      }),
    );
  }

  private async handlePushTask(request: Request): Promise<Response> {
    const agentId = (await this.state.storage.get<string>('agentId')) ?? 'unknown';
    const websockets = this.state.getWebSockets();
    if (websockets.length === 0) {
      console.log(`push-task: agent ${agentId} not connected — returning 503`);
      return new Response('Agent not connected', { status: 503 });
    }

    const payload = (await request.json()) as {
      taskId: string;
      pr: { url: string; number: number; diffUrl: string; base: string; head: string };
      project: { owner: string; repo: string; prompt: string };
      timeout: number;
      diffContent: string;
      reviewCount?: number;
      installationId?: number;
      reviewMode?: 'full' | 'compact';
      synthesizerAgentId?: string;
    };

    console.log(
      `push-task: sending review_request for task ${payload.taskId} to agent ${agentId}` +
        ` (${payload.project.owner}/${payload.project.repo}#${payload.pr.number})`,
    );

    const message: ReviewRequestMessage = {
      id: crypto.randomUUID(),
      timestamp: Date.now(),
      type: 'review_request',
      taskId: payload.taskId,
      pr: payload.pr,
      project: payload.project,
      timeout: payload.timeout,
      diffContent: payload.diffContent,
      reviewMode: payload.reviewMode ?? 'full',
    };

    websockets[0].send(JSON.stringify(message));

    const inFlightTaskIds = (await this.state.storage.get<string[]>('inFlightTaskIds')) ?? [];
    inFlightTaskIds.push(payload.taskId);
    await this.state.storage.put('inFlightTaskIds', inFlightTaskIds);

    // Store per-task metadata for multi-agent review collection
    if (payload.reviewCount !== undefined) {
      const taskMeta: InFlightTaskMeta = {
        reviewCount: payload.reviewCount,
        installationId: payload.installationId ?? 0,
        owner: payload.project.owner,
        repo: payload.project.repo,
        prNumber: payload.pr.number,
        prompt: payload.project.prompt,
        synthesizerAgentId: payload.synthesizerAgentId,
      };
      await this.state.storage.put(`taskMeta:${payload.taskId}`, taskMeta);
    }

    return new Response('OK', { status: 200 });
  }

  private async handlePushSummary(request: Request): Promise<Response> {
    const websockets = this.state.getWebSockets();
    if (websockets.length === 0) {
      return new Response('Agent not connected', { status: 503 });
    }

    const message = (await request.json()) as SummaryRequestMessage;
    websockets[0].send(JSON.stringify(message));

    const inFlightTaskIds = (await this.state.storage.get<string[]>('inFlightTaskIds')) ?? [];
    inFlightTaskIds.push(message.taskId);
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

    console.log(
      `review_complete received: task ${msg.taskId}, agent ${agentId}, verdict ${msg.verdict}, tokens ${msg.tokensUsed}`,
    );

    // Look up task meta to determine single-agent vs multi-agent mode
    const taskMeta = await this.state.storage.get<InFlightTaskMeta>(`taskMeta:${msg.taskId}`);
    const reviewCount = taskMeta?.reviewCount ?? 1;

    // Insert result with review_text and verdict
    const { error } = await supabase.from('review_results').insert({
      review_task_id: msg.taskId,
      agent_id: agentId,
      status: 'completed',
      review_text: msg.review,
      verdict: msg.verdict,
    });
    if (error) {
      console.error(`Failed to insert review result for task ${msg.taskId}:`, error);
    }

    await this.removeInFlightTask(msg.taskId);

    // Always log consumption — even with 0 tokens, the row counts for reviews_per_day
    const { error: logError } = await supabase.from('consumption_logs').insert({
      agent_id: agentId,
      review_task_id: msg.taskId,
      tokens_used: msg.tokensUsed,
    });
    if (logError) {
      console.error(`Failed to insert consumption log for task ${msg.taskId}:`, logError);
    }

    if (reviewCount === 1) {
      // Single-agent mode: post review immediately (M5 backward compatible)
      await this.postReviewDirectly(msg, agentId, supabase);
    } else {
      // Multi-agent mode: check if we have enough results to trigger summarization
      await this.checkAndTriggerSummarization(msg.taskId, reviewCount, taskMeta!, supabase);
    }
  }

  /**
   * Single-agent mode: post review as GitHub PR review immediately.
   */
  private async postReviewDirectly(
    msg: ReviewCompleteMessage,
    agentId: string,
    supabase: ReturnType<typeof createSupabaseClient>,
  ): Promise<void> {
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
      .select('model, tool, users!inner(name)')
      .eq('id', agentId)
      .single();

    const model = agentData?.model ?? 'unknown';
    const tool = agentData?.tool ?? 'unknown';
    const contributorName = agentData
      ? (((agentData.users as unknown as Record<string, unknown>)?.name as string) ?? undefined)
      : undefined;

    // Parse structured review for inline comments
    const parsed = parseStructuredReview(msg.review);
    // Fetch diff from GitHub for inline comment validation
    let diffContent = '';
    try {
      const diffToken = await getInstallationToken(project.github_installation_id, this.env);
      diffContent = await fetchPrDiff(
        project.owner,
        project.repo,
        taskData.pr_number as number,
        diffToken,
      );
    } catch {
      // Diff fetch failed — inline comments will be skipped
    }
    const diffFiles = parseDiffFiles(diffContent);
    const inlineComments = filterValidComments(parsed.comments, diffFiles);

    // Use parsed summary only if inline comments survived validation;
    // otherwise keep the full review text so findings aren't lost
    const hasValidInline = inlineComments.length > 0;
    const reviewBody =
      parsed.summary !== msg.review && hasValidInline ? parsed.summary : msg.review;
    const effectiveVerdict = parsed.verdict ?? msg.verdict;
    const formattedReview = formatReviewComment(
      effectiveVerdict,
      model,
      tool,
      reviewBody,
      contributorName,
    );

    try {
      console.log(
        `Posting review for task ${msg.taskId} to ${project.owner}/${project.repo}#${taskData.pr_number}` +
          ` (installation ${project.github_installation_id}, ${inlineComments.length} inline comments)`,
      );

      const installationToken = await getInstallationToken(
        project.github_installation_id,
        this.env,
      );
      const commentUrl = await postPrReview(
        project.owner,
        project.repo,
        taskData.pr_number as number,
        formattedReview,
        verdictToReviewEvent(effectiveVerdict),
        installationToken,
        inlineComments.length > 0 ? inlineComments : undefined,
      );

      console.log(`Review posted for task ${msg.taskId}: ${commentUrl}`);

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

  /**
   * Multi-agent mode: check completed count and trigger summarization if threshold met.
   */
  private async checkAndTriggerSummarization(
    taskId: string,
    reviewCount: number,
    meta: InFlightTaskMeta,
    supabase: ReturnType<typeof createSupabaseClient>,
  ): Promise<void> {
    // Count completed results for this task
    const { count } = await supabase
      .from('review_results')
      .select('id', { count: 'exact', head: true })
      .eq('review_task_id', taskId)
      .eq('status', 'completed');

    const completedCount = count ?? 0;

    if (completedCount < reviewCount) {
      console.log(
        `Task ${taskId}: ${completedCount}/${reviewCount} reviews completed, waiting for more`,
      );
      return;
    }

    // Transition task to summarizing
    const { error } = await supabase
      .from('review_tasks')
      .update({ status: 'summarizing' })
      .eq('id', taskId)
      .eq('status', 'reviewing');

    if (error) {
      console.error(`Failed to transition task ${taskId} to summarizing:`, error);
      return;
    }

    console.log(`Task ${taskId}: ${completedCount} reviews completed, triggering summarization`);

    await triggerSummarization(this.env, supabase, taskId, meta);
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

    // Look up task info for redistribution (including stored diff and config)
    const { data: taskData } = await supabase
      .from('review_tasks')
      .select(
        'pr_number, pr_url, timeout_at, config_json, projects!inner(owner, repo, github_installation_id)',
      )
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

    // Find another eligible online agent with reputation >= 0
    const { data: candidates } = await supabase
      .from('agents')
      .select('id, user_id, model, tool, reputation_score, repo_config, users!inner(name)')
      .eq('status', 'online')
      .gte('reputation_score', 0);

    const allCandidates: EligibleAgent[] = ((candidates ?? []) as Record<string, unknown>[])
      .filter((a) => !excludedAgentIds.includes(a.id as string))
      .map((row) => ({
        id: row.id as string,
        userId: row.user_id as string,
        userName: ((row.users as Record<string, unknown>)?.name as string) ?? '',
        model: row.model as string,
        tool: row.tool as string,
        reputationScore: row.reputation_score as number,
        repoConfig: (row.repo_config as EligibleAgent['repoConfig']) ?? null,
      }));

    const eligible = filterByRepoConfig(allCandidates, project.owner, project.repo);

    if (eligible.length === 0) {
      await supabase.from('review_tasks').update({ status: 'failed' }).eq('id', taskId);
      console.log(`Task ${taskId} failed: no eligible agents remaining`);
      return;
    }

    const config = (taskData.config_json as Record<string, unknown>) ?? {};
    const timeoutAt = new Date(taskData.timeout_at as string).getTime();
    const remainingSeconds = Math.max(0, Math.floor((timeoutAt - Date.now()) / 1000));

    // Fetch diff for redistribution
    let redistDiff = '';
    try {
      const redistToken = await getInstallationToken(project.github_installation_id, this.env);
      redistDiff = await fetchPrDiff(
        project.owner,
        project.repo,
        taskData.pr_number as number,
        redistToken,
      );
    } catch {
      // Diff fetch failed — agent will get empty diff
    }

    // Push task to the next eligible agent's DO
    const nextAgentId = eligible[0].id;
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
              diffUrl:
                (config.diffUrl as string) ??
                `https://github.com/${project.owner}/${project.repo}/pull/${taskData.pr_number}.diff`,
              base: (config.baseRef as string) ?? 'main',
              head: (config.headRef as string) ?? 'unknown',
            },
            project: {
              owner: project.owner,
              repo: project.repo,
              prompt: (config.prompt as string) ?? '',
            },
            timeout: remainingSeconds,
            diffContent: redistDiff,
            reviewCount: (config.reviewCount as number) ?? 1,
            installationId: project.github_installation_id,
            reviewMode: ((config.reviewCount as number) ?? 1) > 1 ? 'compact' : 'full',
          }),
        }),
      );
      console.log(`Task ${taskId} redistributed to agent ${nextAgentId}`);
    } catch (err) {
      console.error(`Failed to redistribute task ${taskId} to agent ${nextAgentId}:`, err);
    }
  }

  private async handleSummaryComplete(msg: SummaryCompleteMessage): Promise<void> {
    const agentId = (await this.state.storage.get<string>('agentId')) ?? '';
    const supabase = createSupabaseClient(this.env);

    await this.removeInFlightTask(msg.taskId);

    // Always log consumption for the summary agent
    const { error: summaryLogError } = await supabase.from('consumption_logs').insert({
      agent_id: agentId,
      review_task_id: msg.taskId,
      tokens_used: msg.tokensUsed,
    });
    if (summaryLogError) {
      console.error(
        `Failed to insert consumption log for summary task ${msg.taskId}:`,
        summaryLogError,
      );
    }

    // Look up task + project info
    const { data: taskData } = await supabase
      .from('review_tasks')
      .select('pr_number, pr_url, project_id, projects!inner(owner, repo, github_installation_id)')
      .eq('id', msg.taskId)
      .single();

    if (!taskData) {
      console.error(`Task ${msg.taskId} not found for summary posting`);
      return;
    }

    const project = taskData.projects as unknown as {
      owner: string;
      repo: string;
      github_installation_id: number;
    };

    try {
      const installationToken = await getInstallationToken(
        project.github_installation_id,
        this.env,
      );

      // Get the number of contributing reviews for the summary header
      const { count: reviewCountResult } = await supabase
        .from('review_results')
        .select('id', { count: 'exact', head: true })
        .eq('review_task_id', msg.taskId)
        .eq('status', 'completed');

      // Parse structured review for inline comments
      const parsed = parseStructuredReview(msg.summary);
      // Fetch diff from GitHub for inline comment validation
      let diffContent = '';
      try {
        const diffToken = await getInstallationToken(project.github_installation_id, this.env);
        diffContent = await fetchPrDiff(
          project.owner,
          project.repo,
          taskData.pr_number as number,
          diffToken,
        );
      } catch {
        // Diff fetch failed — inline comments will be skipped
      }
      const diffFiles = parseDiffFiles(diffContent);
      const inlineComments = filterValidComments(parsed.comments, diffFiles);

      // If inline comments were extracted but none survived validation,
      // use the full original text so findings aren't lost
      const hasValidInline = inlineComments.length > 0;
      const summaryText =
        parsed.summary !== msg.summary && hasValidInline ? parsed.summary : msg.summary;
      const contributorNames = await fetchReviewContributors(supabase, msg.taskId);
      const summaryBody = formatSummaryComment(
        summaryText,
        reviewCountResult ?? 0,
        contributorNames,
      );
      const event = parsed.verdict ? verdictToReviewEvent(parsed.verdict) : 'COMMENT';
      const summaryUrl = await postPrReview(
        project.owner,
        project.repo,
        taskData.pr_number as number,
        summaryBody,
        event,
        installationToken,
        inlineComments.length > 0 ? inlineComments : undefined,
      );

      // Update review_summaries with comment_url
      await supabase
        .from('review_summaries')
        .update({ comment_url: summaryUrl })
        .eq('review_task_id', msg.taskId)
        .eq('agent_id', agentId);

      // Transition task to completed
      await supabase.from('review_tasks').update({ status: 'completed' }).eq('id', msg.taskId);

      console.log(`Summary posted for task ${msg.taskId}`);
    } catch (err) {
      console.error(`Failed to post summary for task ${msg.taskId}:`, err);

      // Fallback: try posting individual reviews
      const reviews = await fetchCompletedReviews(supabase, msg.taskId);
      const meta: InFlightTaskMeta = {
        reviewCount: 0,
        installationId: project.github_installation_id,
        owner: project.owner,
        repo: project.repo,
        prNumber: taskData.pr_number as number,
        prompt: '',
      };
      await postIndividualReviewsFallback(this.env, supabase, msg.taskId, meta, reviews);
    }
  }
}
