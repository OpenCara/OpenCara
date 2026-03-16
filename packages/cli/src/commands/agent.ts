import { Command } from 'commander';
import WebSocket from 'ws';
import crypto from 'node:crypto';
import type {
  CreateAgentRequest,
  CreateAgentResponse,
  ListAgentsResponse,
  AgentResponse,
  PlatformMessage,
  ReviewRequestMessage,
  SummaryRequestMessage,
} from '@opencrust/shared';
import { loadConfig, requireApiKey, type ConsumptionLimits } from '../config.js';
import { ApiClient } from '../http.js';
import { calculateDelay, sleep, DEFAULT_RECONNECT_OPTIONS } from '../reconnect.js';
import { executeReview, DiffTooLargeError, type ReviewExecutorDeps } from '../review.js';
import { executeSummary, InputTooLargeError } from '../summary.js';
import {
  checkConsumptionLimits,
  fetchConsumptionStats,
  createSessionTracker,
  recordSessionUsage,
  formatPostReviewStats,
  type SessionStats,
} from '../consumption.js';

export interface ConsumptionDeps {
  client: ApiClient;
  agentId: string;
  limits: ConsumptionLimits | null;
  session: SessionStats;
}

function formatTable(agents: AgentResponse[]): void {
  if (agents.length === 0) {
    console.log('No agents registered. Run `opencrust agent create` to register one.');
    return;
  }

  const header = [
    'ID'.padEnd(38),
    'Model'.padEnd(22),
    'Tool'.padEnd(16),
    'Status'.padEnd(10),
    'Reputation',
  ].join('');
  console.log(header);

  for (const a of agents) {
    console.log(
      [
        a.id.padEnd(38),
        a.model.padEnd(22),
        a.tool.padEnd(16),
        a.status.padEnd(10),
        a.reputationScore.toFixed(2),
      ].join(''),
    );
  }
}

function buildWsUrl(platformUrl: string, agentId: string, apiKey: string): string {
  return (
    platformUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://') +
    `/ws/agent/${agentId}?token=${encodeURIComponent(apiKey)}`
  );
}

export { buildWsUrl };

const HEARTBEAT_TIMEOUT_MS = 90_000;

function startAgent(
  agentId: string,
  platformUrl: string,
  apiKey: string,
  reviewDeps?: ReviewExecutorDeps,
  consumptionDeps?: ConsumptionDeps,
): void {
  let attempt = 0;
  let intentionalClose = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let currentWs: WebSocket | null = null;

  function clearHeartbeatTimer(): void {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function shutdown(): void {
    intentionalClose = true;
    clearHeartbeatTimer();
    if (currentWs) currentWs.close();
    console.log('Disconnected.');
    process.exit(0);
  }

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);

  function connect(): void {
    const url = buildWsUrl(platformUrl, agentId, apiKey);
    const ws = new WebSocket(url);
    currentWs = ws;

    function resetHeartbeatTimer(): void {
      clearHeartbeatTimer();
      heartbeatTimer = setTimeout(() => {
        console.log('No heartbeat received in 90s. Reconnecting...');
        ws.terminate();
      }, HEARTBEAT_TIMEOUT_MS);
    }

    ws.on('open', () => {
      attempt = 0;
      console.log('Connected to platform.');
      resetHeartbeatTimer();
    });

    ws.on('message', (data: WebSocket.Data) => {
      let msg: PlatformMessage & { type: string; version?: string; code?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      handleMessage(ws, msg, resetHeartbeatTimer, reviewDeps, consumptionDeps);
    });

    ws.on('close', (code, reason) => {
      clearHeartbeatTimer();
      if (intentionalClose) return;
      console.log(`Disconnected (code=${code}, reason=${reason.toString()}).`);
      reconnect();
    });

    ws.on('error', (err) => {
      console.error(`WebSocket error: ${err.message}`);
    });
  }

  async function reconnect(): Promise<void> {
    const delay = calculateDelay(attempt, DEFAULT_RECONNECT_OPTIONS);
    const delaySec = (delay / 1000).toFixed(1);
    attempt++;
    console.log(`Reconnecting in ${delaySec}s... (attempt ${attempt})`);
    await sleep(delay);
    connect();
  }

  connect();
}

function trySend(ws: { send: (data: string) => void }, data: Record<string, unknown>): void {
  try {
    ws.send(JSON.stringify(data));
  } catch {
    console.error('Failed to send message — WebSocket may be closed');
  }
}

async function logPostReviewStats(
  type: 'Review' | 'Summary',
  verdict: string | undefined,
  tokensUsed: number,
  consumptionDeps?: ConsumptionDeps,
): Promise<void> {
  if (!consumptionDeps) {
    if (verdict) {
      console.log(`${type} complete: ${verdict} (${tokensUsed} tokens)`);
    } else {
      console.log(`${type} complete (${tokensUsed} tokens)`);
    }
    return;
  }

  recordSessionUsage(consumptionDeps.session, tokensUsed);

  let dailyStats: { tokens: number; reviews: number } | undefined;
  try {
    const stats = await fetchConsumptionStats(consumptionDeps.client, consumptionDeps.agentId);
    dailyStats = stats.period.last24h;
  } catch {
    // Graceful degradation — skip daily stats display
  }

  if (verdict) {
    console.log(`${type} complete: ${verdict} (${tokensUsed.toLocaleString()} tokens)`);
  } else {
    console.log(`${type} complete (${tokensUsed.toLocaleString()} tokens)`);
  }
  console.log(
    formatPostReviewStats(tokensUsed, consumptionDeps.session, consumptionDeps.limits, dailyStats),
  );
}

export function handleMessage(
  ws: { send: (data: string) => void },
  msg: { type: string; version?: string; code?: string; taskId?: string; timestamp?: number },
  resetHeartbeat?: () => void,
  reviewDeps?: ReviewExecutorDeps,
  consumptionDeps?: ConsumptionDeps,
): void {
  switch (msg.type) {
    case 'connected':
      console.log(`Authenticated. Protocol v${msg.version ?? 'unknown'}`);
      break;

    case 'heartbeat_ping':
      ws.send(JSON.stringify({ type: 'heartbeat_pong', timestamp: Date.now() }));
      if (resetHeartbeat) resetHeartbeat();
      break;

    case 'review_request': {
      const request = msg as unknown as ReviewRequestMessage;
      console.log(
        `Review request: task ${request.taskId} for ${request.project.owner}/${request.project.repo}#${request.pr.number}`,
      );

      if (!reviewDeps) {
        ws.send(
          JSON.stringify({
            type: 'review_rejected',
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            taskId: request.taskId,
            reason: 'Review execution not configured',
          }),
        );
        break;
      }

      void (async () => {
        // Check consumption limits before executing
        if (consumptionDeps) {
          const limitResult = await checkConsumptionLimits(
            consumptionDeps.client,
            consumptionDeps.agentId,
            consumptionDeps.limits,
          );
          if (!limitResult.allowed) {
            trySend(ws, {
              type: 'review_rejected',
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              taskId: request.taskId,
              reason: limitResult.reason ?? 'consumption_limit_exceeded',
            });
            console.log(`Review rejected: ${limitResult.reason}`);
            return;
          }
        }

        try {
          const result = await executeReview(
            {
              taskId: request.taskId,
              diffContent: request.diffContent,
              prompt: request.project.prompt,
              owner: request.project.owner,
              repo: request.project.repo,
              prNumber: request.pr.number,
              timeout: request.timeout,
            },
            reviewDeps,
          );
          trySend(ws, {
            type: 'review_complete',
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            taskId: request.taskId,
            review: result.review,
            verdict: result.verdict,
            tokensUsed: result.tokensUsed,
          });
          await logPostReviewStats('Review', result.verdict, result.tokensUsed, consumptionDeps);
        } catch (err: unknown) {
          if (err instanceof DiffTooLargeError) {
            trySend(ws, {
              type: 'review_rejected',
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              taskId: request.taskId,
              reason: err.message,
            });
          } else {
            trySend(ws, {
              type: 'review_error',
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              taskId: request.taskId,
              error: err instanceof Error ? err.message : 'Unknown error',
            });
          }
          console.error('Review failed:', err);
        }
      })();
      break;
    }

    case 'summary_request': {
      const summaryRequest = msg as unknown as SummaryRequestMessage;
      console.log(
        `Summary request: task ${summaryRequest.taskId} for ${summaryRequest.project.owner}/${summaryRequest.project.repo}#${summaryRequest.pr.number} (${summaryRequest.reviews.length} reviews)`,
      );

      if (!reviewDeps) {
        trySend(ws, {
          type: 'review_rejected',
          id: crypto.randomUUID(),
          timestamp: Date.now(),
          taskId: summaryRequest.taskId,
          reason: 'Review tool not configured',
        });
        break;
      }

      void (async () => {
        // Check consumption limits before executing
        if (consumptionDeps) {
          const limitResult = await checkConsumptionLimits(
            consumptionDeps.client,
            consumptionDeps.agentId,
            consumptionDeps.limits,
          );
          if (!limitResult.allowed) {
            trySend(ws, {
              type: 'review_rejected',
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              taskId: summaryRequest.taskId,
              reason: limitResult.reason ?? 'consumption_limit_exceeded',
            });
            console.log(`Summary rejected: ${limitResult.reason}`);
            return;
          }
        }

        try {
          const result = await executeSummary(
            {
              taskId: summaryRequest.taskId,
              reviews: summaryRequest.reviews,
              prompt: summaryRequest.project.prompt,
              owner: summaryRequest.project.owner,
              repo: summaryRequest.project.repo,
              prNumber: summaryRequest.pr.number,
              timeout: summaryRequest.timeout,
            },
            reviewDeps,
          );
          trySend(ws, {
            type: 'summary_complete',
            id: crypto.randomUUID(),
            timestamp: Date.now(),
            taskId: summaryRequest.taskId,
            summary: result.summary,
            tokensUsed: result.tokensUsed,
          });
          await logPostReviewStats('Summary', undefined, result.tokensUsed, consumptionDeps);
        } catch (err: unknown) {
          if (err instanceof InputTooLargeError) {
            trySend(ws, {
              type: 'review_rejected',
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              taskId: summaryRequest.taskId,
              reason: err.message,
            });
          } else {
            trySend(ws, {
              type: 'review_error',
              id: crypto.randomUUID(),
              timestamp: Date.now(),
              taskId: summaryRequest.taskId,
              error: err instanceof Error ? err.message : 'Summary failed',
            });
          }
          console.error('Summary failed:', err);
        }
      })();
      break;
    }

    case 'error':
      console.error(`Platform error: ${msg.code ?? 'unknown'}`);
      if (msg.code === 'auth_revoked') process.exit(1);
      break;

    default:
      break;
  }
}

export const agentCommand = new Command('agent').description('Manage review agents');

agentCommand
  .command('create')
  .description('Register a new agent')
  .requiredOption('--model <model>', 'AI model (e.g., claude-sonnet-4-6)')
  .requiredOption('--tool <tool>', 'Review tool (e.g., claude-code)')
  .action(async (opts: { model: string; tool: string }) => {
    const config = loadConfig();
    const apiKey = requireApiKey(config);
    const client = new ApiClient(config.platformUrl, apiKey);

    const body: CreateAgentRequest = { model: opts.model, tool: opts.tool };
    let agent: CreateAgentResponse;
    try {
      agent = await client.post<CreateAgentResponse>('/api/agents', body);
    } catch (err) {
      console.error('Failed to create agent:', err instanceof Error ? err.message : err);
      process.exit(1);
    }

    console.log('Agent created:');
    console.log(`  ID:    ${agent.id}`);
    console.log(`  Model: ${agent.model}`);
    console.log(`  Tool:  ${agent.tool}`);
  });

agentCommand
  .command('list')
  .description('List registered agents')
  .action(async () => {
    const config = loadConfig();
    const apiKey = requireApiKey(config);
    const client = new ApiClient(config.platformUrl, apiKey);

    let res: ListAgentsResponse;
    try {
      res = await client.get<ListAgentsResponse>('/api/agents');
    } catch (err) {
      console.error('Failed to list agents:', err instanceof Error ? err.message : err);
      process.exit(1);
    }

    formatTable(res.agents);
  });

agentCommand
  .command('start [agentId]')
  .description('Connect agent to platform via WebSocket')
  .action(async (agentId?: string) => {
    const config = loadConfig();
    const apiKey = requireApiKey(config);

    const client = new ApiClient(config.platformUrl, apiKey);
    let agentTool: string | undefined;

    if (!agentId) {
      let res: ListAgentsResponse;
      try {
        res = await client.get<ListAgentsResponse>('/api/agents');
      } catch (err) {
        console.error('Failed to list agents:', err instanceof Error ? err.message : err);
        process.exit(1);
      }

      if (res.agents.length === 0) {
        console.error('No agents registered. Run `opencrust agent create` first.');
        process.exit(1);
      }

      if (res.agents.length === 1) {
        agentId = res.agents[0].id;
        agentTool = res.agents[0].tool;
        console.log(`Using agent ${agentId}`);
      } else {
        console.error('Multiple agents found. Please specify an agent ID:');
        for (const a of res.agents) {
          console.error(`  ${a.id}  ${a.model} / ${a.tool}`);
        }
        process.exit(1);
      }
    } else {
      // Fetch agent info to get the tool field
      try {
        const res = await client.get<ListAgentsResponse>('/api/agents');
        const agent = res.agents.find((a) => a.id === agentId);
        if (agent) {
          agentTool = agent.tool;
        }
      } catch {
        // If we can't fetch agent info, we'll proceed without tool
      }
    }

    let reviewDeps: ReviewExecutorDeps | undefined;
    if (agentTool) {
      reviewDeps = {
        tool: agentTool,
        maxDiffSizeKb: config.maxDiffSizeKb,
      };
    } else {
      console.warn('Warning: Could not determine agent tool. Reviews will be rejected.');
    }

    const consumptionDeps: ConsumptionDeps = {
      client,
      agentId,
      limits: config.limits,
      session: createSessionTracker(),
    };

    console.log(`Starting agent ${agentId}...`);
    startAgent(agentId, config.platformUrl, apiKey, reviewDeps, consumptionDeps);
  });
