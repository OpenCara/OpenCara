import { Command } from 'commander';
import WebSocket from 'ws';
import type {
  CreateAgentRequest,
  CreateAgentResponse,
  ListAgentsResponse,
  AgentResponse,
  PlatformMessage,
} from '@opencrust/shared';
import { loadConfig, requireApiKey } from '../config.js';
import { ApiClient } from '../http.js';
import {
  calculateDelay,
  sleep,
  DEFAULT_RECONNECT_OPTIONS,
} from '../reconnect.js';

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

function startAgent(agentId: string, platformUrl: string, apiKey: string): void {
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

      handleMessage(ws, msg, resetHeartbeatTimer);
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

export function handleMessage(
  ws: { send: (data: string) => void },
  msg: { type: string; version?: string; code?: string; taskId?: string; timestamp?: number },
  resetHeartbeat?: () => void,
): void {
  switch (msg.type) {
    case 'connected':
      console.log(`Authenticated. Protocol v${msg.version ?? 'unknown'}`);
      break;

    case 'heartbeat_ping':
      ws.send(JSON.stringify({ type: 'heartbeat_pong', timestamp: Date.now() }));
      if (resetHeartbeat) resetHeartbeat();
      break;

    case 'review_request':
      console.log(`Review request received: task ${msg.taskId}`);
      ws.send(
        JSON.stringify({
          type: 'review_rejected',
          taskId: msg.taskId,
          reason: 'Review execution not yet implemented',
        }),
      );
      break;

    case 'summary_request':
      console.log(`Summary request received: task ${msg.taskId}`);
      ws.send(
        JSON.stringify({
          type: 'review_rejected',
          taskId: msg.taskId,
          reason: 'Summary execution not yet implemented',
        }),
      );
      break;

    case 'error':
      console.error(`Platform error: ${msg.code ?? 'unknown'}`);
      if (msg.code === 'auth_revoked') process.exit(1);
      break;

    default:
      break;
  }
}

export const agentCommand = new Command('agent').description(
  'Manage review agents',
);

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
      console.error(
        'Failed to create agent:',
        err instanceof Error ? err.message : err,
      );
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
      console.error(
        'Failed to list agents:',
        err instanceof Error ? err.message : err,
      );
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

    if (!agentId) {
      const client = new ApiClient(config.platformUrl, apiKey);
      let res: ListAgentsResponse;
      try {
        res = await client.get<ListAgentsResponse>('/api/agents');
      } catch (err) {
        console.error(
          'Failed to list agents:',
          err instanceof Error ? err.message : err,
        );
        process.exit(1);
      }

      if (res.agents.length === 0) {
        console.error('No agents registered. Run `opencrust agent create` first.');
        process.exit(1);
      }

      if (res.agents.length === 1) {
        agentId = res.agents[0].id;
        console.log(`Using agent ${agentId}`);
      } else {
        console.error('Multiple agents found. Please specify an agent ID:');
        for (const a of res.agents) {
          console.error(`  ${a.id}  ${a.model} / ${a.tool}`);
        }
        process.exit(1);
      }
    }

    console.log(`Starting agent ${agentId}...`);
    startAgent(agentId, config.platformUrl, apiKey);
  });
