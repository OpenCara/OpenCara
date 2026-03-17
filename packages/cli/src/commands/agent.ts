import { Command } from 'commander';
import WebSocket from 'ws';
import crypto from 'node:crypto';
import {
  DEFAULT_REGISTRY,
  type CreateAgentRequest,
  type CreateAgentResponse,
  type ListAgentsResponse,
  type AgentResponse,
  type AgentStatsResponse,
  type RegistryResponse,
  type PlatformMessage,
  type ReviewRequestMessage,
  type SummaryRequestMessage,
} from '@opencrust/shared';
import {
  loadConfig,
  saveConfig,
  requireApiKey,
  type ConsumptionLimits,
  type LocalAgentConfig,
} from '../config.js';
import { ApiClient } from '../http.js';
import { calculateDelay, sleep, DEFAULT_RECONNECT_OPTIONS } from '../reconnect.js';
import { executeReview, DiffTooLargeError, type ReviewExecutorDeps } from '../review.js';
import { executeSummary, InputTooLargeError } from '../summary.js';
import { resolveCommandTemplate, validateCommandBinary } from '../tool-executor.js';
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

/** Minimum time (ms) a connection must be alive before we reset the attempt counter */
const CONNECTION_STABILITY_THRESHOLD_MS = 30_000;

function formatTable(agents: AgentResponse[], trustLabels?: Map<string, string>): void {
  if (agents.length === 0) {
    console.log('No agents registered. Run `opencrust agent create` to register one.');
    return;
  }

  const header = [
    'ID'.padEnd(38),
    'Model'.padEnd(22),
    'Tool'.padEnd(16),
    'Status'.padEnd(10),
    'Trust',
  ].join('');
  console.log(header);

  for (const a of agents) {
    const trust = trustLabels?.get(a.id) ?? '--';
    console.log(
      [a.id.padEnd(38), a.model.padEnd(22), a.tool.padEnd(16), a.status.padEnd(10), trust].join(''),
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

export const STABILITY_THRESHOLD_MIN_MS = 5_000;
export const STABILITY_THRESHOLD_MAX_MS = 300_000;

export interface StartAgentOptions {
  verbose?: boolean;
  stabilityThresholdMs?: number;
}

export function startAgent(
  agentId: string,
  platformUrl: string,
  apiKey: string,
  reviewDeps?: ReviewExecutorDeps,
  consumptionDeps?: ConsumptionDeps,
  options?: StartAgentOptions,
): void {
  const verbose = options?.verbose ?? false;
  const stabilityThreshold = options?.stabilityThresholdMs ?? CONNECTION_STABILITY_THRESHOLD_MS;
  let attempt = 0;
  let intentionalClose = false;
  let heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  let currentWs: WebSocket | null = null;
  let connectionOpenedAt: number | null = null;
  let stabilityTimer: ReturnType<typeof setTimeout> | null = null;

  function clearHeartbeatTimer(): void {
    if (heartbeatTimer) {
      clearTimeout(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function clearStabilityTimer(): void {
    if (stabilityTimer) {
      clearTimeout(stabilityTimer);
      stabilityTimer = null;
    }
  }

  function shutdown(): void {
    intentionalClose = true;
    clearHeartbeatTimer();
    clearStabilityTimer();
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
      connectionOpenedAt = Date.now();
      console.log('Connected to platform.');
      resetHeartbeatTimer();

      if (verbose) {
        console.log(`[verbose] Connection opened at ${new Date(connectionOpenedAt).toISOString()}`);
      }

      // Deferred attempt reset: only reset after connection is stable
      clearStabilityTimer();
      stabilityTimer = setTimeout(() => {
        if (verbose) {
          console.log(
            `[verbose] Connection stable for ${stabilityThreshold / 1000}s — resetting reconnect counter`,
          );
        }
        attempt = 0;
      }, stabilityThreshold);
    });

    ws.on('message', (data: WebSocket.Data) => {
      let msg: PlatformMessage & { type: string; version?: string; code?: string };
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return;
      }

      handleMessage(ws, msg, resetHeartbeatTimer, reviewDeps, consumptionDeps, verbose);
    });

    ws.on('close', (code, reason) => {
      clearHeartbeatTimer();
      clearStabilityTimer();

      if (intentionalClose) return;
      if (ws !== currentWs) return; // Stale WS — don't reconnect

      // Log connection lifetime
      if (connectionOpenedAt) {
        const lifetimeMs = Date.now() - connectionOpenedAt;
        const lifetimeSec = (lifetimeMs / 1000).toFixed(1);
        console.log(
          `Disconnected (code=${code}, reason=${reason.toString()}). Connection was alive for ${lifetimeSec}s.`,
        );
      } else {
        console.log(`Disconnected (code=${code}, reason=${reason.toString()}).`);
      }

      if (code === 4002) {
        console.log('Connection replaced by server — not reconnecting.');
        return;
      }

      connectionOpenedAt = null;
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
  verbose?: boolean,
): void {
  switch (msg.type) {
    case 'connected':
      console.log(`Authenticated. Protocol v${msg.version ?? 'unknown'}`);
      break;

    case 'heartbeat_ping':
      ws.send(JSON.stringify({ type: 'heartbeat_pong', timestamp: Date.now() }));
      if (verbose) {
        console.log(`[verbose] Heartbeat ping received, pong sent at ${new Date().toISOString()}`);
      }
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

/** Sync a local agent to the server: find existing by model+tool or create new */
async function syncAgentToServer(
  client: ApiClient,
  serverAgents: AgentResponse[],
  localAgent: LocalAgentConfig,
): Promise<{ agentId: string; created: boolean }> {
  const existing = serverAgents.find(
    (a) => a.model === localAgent.model && a.tool === localAgent.tool,
  );
  if (existing) {
    return { agentId: existing.id, created: false };
  }

  const body: CreateAgentRequest = { model: localAgent.model, tool: localAgent.tool };
  const created = await client.post<CreateAgentResponse>('/api/agents', body);
  return { agentId: created.id, created: true };
}

/** Resolve the effective command template for a local agent */
function resolveLocalAgentCommand(
  localAgent: LocalAgentConfig,
  globalAgentCommand: string | null,
): string {
  const effectiveCommand = localAgent.command ?? globalAgentCommand;
  return resolveCommandTemplate(effectiveCommand);
}

export { syncAgentToServer, resolveLocalAgentCommand };

export const agentCommand = new Command('agent').description('Manage review agents');

agentCommand
  .command('create')
  .description('Add an agent to local config (interactive or via flags)')
  .option('--model <model>', 'AI model name (e.g., claude-opus-4-6)')
  .option('--tool <tool>', 'Review tool name (e.g., claude-code)')
  .option('--command <cmd>', 'Custom command template (bypasses registry lookup)')
  .action(async (opts: { model?: string; tool?: string; command?: string }) => {
    const config = loadConfig();
    requireApiKey(config);

    let model: string;
    let tool: string;
    let command: string | undefined = opts.command;

    if (opts.model && opts.tool) {
      // Non-interactive mode
      model = opts.model;
      tool = opts.tool;
    } else if (opts.model || opts.tool) {
      console.error('Both --model and --tool are required in non-interactive mode.');
      process.exit(1);
    } else {
      // Interactive mode: fetch registry and prompt
      const client = new ApiClient(config.platformUrl, config.apiKey!);
      let registry: RegistryResponse;
      try {
        registry = await client.get<RegistryResponse>('/api/registry');
      } catch {
        console.warn('Could not fetch registry from server. Using built-in defaults.');
        registry = DEFAULT_REGISTRY;
      }

      const { search, input } = await import('@inquirer/prompts');

      const searchTheme = {
        style: {
          keysHelpTip: (keys: Array<[string, string]>) =>
            keys.map(([key, action]) => `${key} ${action}`).join(', ') + ', ^C exit',
        },
      };

      const existingAgents = config.agents ?? [];
      const toolChoices = registry.tools.map((t) => ({
        name: t.displayName,
        value: t.name,
      }));

      try {
        // Loop: select tool → select model → check duplicate → if dup, restart
        // eslint-disable-next-line no-constant-condition
        while (true) {
          // Step 1: Select tool
          tool = await search({
            message: 'Select a tool:',
            theme: searchTheme,
            source: (term) => {
              const q = (term ?? '').toLowerCase();
              return toolChoices.filter(
                (c) => c.name.toLowerCase().includes(q) || c.value.toLowerCase().includes(q),
              );
            },
          });

          // Step 2: Select model — compatible first, others dimmed
          const compatible = registry.models.filter((m) => m.tools.includes(tool));
          const incompatible = registry.models.filter((m) => !m.tools.includes(tool));

          const modelChoices = [
            ...compatible.map((m) => ({
              name: m.displayName,
              value: m.name,
            })),
            ...incompatible.map((m) => ({
              name: `\x1b[38;5;249m${m.displayName}\x1b[0m`,
              value: m.name,
            })),
          ];

          model = await search({
            message: 'Select a model:',
            theme: searchTheme,
            source: (term) => {
              const q = (term ?? '').toLowerCase();
              return modelChoices.filter(
                (c) => c.value.toLowerCase().includes(q) || c.name.toLowerCase().includes(q),
              );
            },
          });

          // Check duplicate before proceeding
          const isDup = existingAgents.some((a) => a.model === model && a.tool === tool);
          if (isDup) {
            console.warn(`"${model}" / "${tool}" already exists in config. Choose again.`);
            continue;
          }

          // Warn if model isn't compatible with selected tool
          const modelEntry = registry.models.find((m) => m.name === model);
          if (modelEntry && !modelEntry.tools.includes(tool)) {
            console.warn(`Warning: "${model}" is not listed as compatible with "${tool}".`);
          }

          break;
        }

        // Step 3: Resolve default command and let user edit it
        const toolEntry = registry.tools.find((t) => t.name === tool);
        const defaultCommand = toolEntry
          ? toolEntry.commandTemplate.replaceAll('${MODEL}', model)
          : `${tool} --model ${model} -p \${PROMPT}`;

        command = await input({
          message: 'Command:',
          default: defaultCommand,
          prefill: 'editable',
        });
      } catch (err) {
        if (err && typeof err === 'object' && 'name' in err && err.name === 'ExitPromptError') {
          console.log('Cancelled.');
          return;
        }
        throw err;
      }
    }

    // Resolve command from registry if not set (non-interactive mode)
    if (!command) {
      const toolEntry = DEFAULT_REGISTRY.tools.find((t) => t.name === tool);
      if (toolEntry) {
        command = toolEntry.commandTemplate.replaceAll('${MODEL}', model);
      } else {
        console.error(`No command template for tool "${tool}". Use --command to specify one.`);
        process.exit(1);
      }
    }

    // Validate binary
    if (validateCommandBinary(command)) {
      console.log(`Verifying... binary found.`);
    } else {
      console.warn(
        `Warning: binary for command "${command.split(' ')[0]}" not found on this machine.`,
      );
    }

    // Write to local config
    const newAgent: LocalAgentConfig = { model, tool, command };
    if (config.agents === null) {
      config.agents = [];
    }

    const isDuplicate = config.agents.some((a) => a.model === model && a.tool === tool);
    if (isDuplicate) {
      console.error(`Agent with model "${model}" and tool "${tool}" already exists in config.`);
      process.exit(1);
    }

    config.agents.push(newAgent);
    saveConfig(config);

    console.log('Agent added to config:');
    console.log(`  Model:   ${model}`);
    console.log(`  Tool:    ${tool}`);
    console.log(`  Command: ${command}`);
  });

agentCommand
  .command('init')
  .description('Import server-side agents into local config')
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

    if (res.agents.length === 0) {
      console.log('No server-side agents found. Use `opencrust agent create` to add one.');
      return;
    }

    // Fetch registry for command templates
    let registry: RegistryResponse;
    try {
      registry = await client.get<RegistryResponse>('/api/registry');
    } catch {
      registry = DEFAULT_REGISTRY;
    }
    const toolCommands = new Map(registry.tools.map((t) => [t.name, t.commandTemplate]));

    const existing = config.agents ?? [];
    let imported = 0;

    for (const agent of res.agents) {
      const isDuplicate = existing.some((e) => e.model === agent.model && e.tool === agent.tool);
      if (isDuplicate) continue;

      let command = toolCommands.get(agent.tool);
      if (command) {
        command = command.replaceAll('${MODEL}', agent.model);
      } else {
        console.warn(
          `Warning: no command template for ${agent.model}/${agent.tool} — set command manually in config`,
        );
      }
      existing.push({ model: agent.model, tool: agent.tool, command });
      imported++;
    }

    config.agents = existing;
    saveConfig(config);

    console.log(`Imported ${imported} agent(s) to local config.`);
    if (imported > 0) {
      console.log('Edit ~/.opencrust/config.yml to adjust commands for your system.');
    }
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

    // Fetch trust tier labels for each agent
    const trustLabels = new Map<string, string>();
    for (const agent of res.agents) {
      try {
        const stats = await client.get<AgentStatsResponse>(`/api/stats/${agent.id}`);
        trustLabels.set(agent.id, stats.agent.trustTier.label);
      } catch {
        // Leave as '--' if stats unavailable
      }
    }

    formatTable(res.agents, trustLabels);
  });

agentCommand
  .command('start [agentIdOrModel]')
  .description('Connect agent to platform via WebSocket')
  .option('--verbose', 'Enable detailed WebSocket diagnostic logging')
  .option(
    '--stability-threshold <ms>',
    `Connection stability threshold in ms (${STABILITY_THRESHOLD_MIN_MS}–${STABILITY_THRESHOLD_MAX_MS}, default: ${CONNECTION_STABILITY_THRESHOLD_MS})`,
  )
  .action(
    async (
      agentIdOrModel: string | undefined,
      opts: { verbose?: boolean; stabilityThreshold?: string },
    ) => {
      let stabilityThresholdMs: number | undefined;
      if (opts.stabilityThreshold !== undefined) {
        const val = Number(opts.stabilityThreshold);
        if (
          !Number.isInteger(val) ||
          val < STABILITY_THRESHOLD_MIN_MS ||
          val > STABILITY_THRESHOLD_MAX_MS
        ) {
          console.error(
            `Invalid --stability-threshold: must be an integer between ${STABILITY_THRESHOLD_MIN_MS} and ${STABILITY_THRESHOLD_MAX_MS}`,
          );
          process.exit(1);
        }
        stabilityThresholdMs = val;
      }

      const config = loadConfig();
      const apiKey = requireApiKey(config);
      const client = new ApiClient(config.platformUrl, apiKey);

      // === Path B: Local-config mode (agents section exists) ===
      if (config.agents !== null) {
        // Validate and filter agents by binary availability
        const validAgents: Array<{ local: LocalAgentConfig; command: string }> = [];
        for (const local of config.agents) {
          let cmd: string;
          try {
            cmd = resolveLocalAgentCommand(local, config.agentCommand);
          } catch (err) {
            console.warn(
              `Skipping ${local.model}/${local.tool}: ${err instanceof Error ? err.message : 'no command template available'}`,
            );
            continue;
          }
          if (!validateCommandBinary(cmd)) {
            console.warn(
              `Skipping ${local.model}/${local.tool}: binary "${cmd.split(' ')[0]}" not found`,
            );
            continue;
          }
          validAgents.push({ local, command: cmd });
        }

        if (validAgents.length === 0) {
          console.error('No valid agents in config. Check that tool binaries are installed.');
          process.exit(1);
        }

        // Select agent
        let selected: { local: LocalAgentConfig; command: string };
        if (agentIdOrModel) {
          const match = validAgents.find((a) => a.local.model === agentIdOrModel);
          if (!match) {
            console.error(`No agent with model "${agentIdOrModel}" found in local config.`);
            console.error('Available agents:');
            for (const a of validAgents) {
              console.error(`  ${a.local.model}  (${a.local.tool})`);
            }
            process.exit(1);
          }
          selected = match;
        } else if (validAgents.length === 1) {
          selected = validAgents[0];
          console.log(`Using agent ${selected.local.model} (${selected.local.tool})`);
        } else {
          console.error('Multiple agents in config. Specify a model name:');
          for (const a of validAgents) {
            console.error(`  ${a.local.model}  (${a.local.tool})`);
          }
          process.exit(1);
        }

        // Sync to server
        let serverAgents: AgentResponse[];
        try {
          const res = await client.get<ListAgentsResponse>('/api/agents');
          serverAgents = res.agents;
        } catch (err) {
          console.error('Failed to fetch agents:', err instanceof Error ? err.message : err);
          process.exit(1);
        }

        let agentId: string;
        try {
          const sync = await syncAgentToServer(client, serverAgents, selected.local);
          agentId = sync.agentId;
          if (sync.created) {
            console.log(`Registered new agent ${agentId} on platform`);
          }
        } catch (err) {
          console.error(
            'Failed to sync agent to server:',
            err instanceof Error ? err.message : err,
          );
          process.exit(1);
        }

        const reviewDeps: ReviewExecutorDeps = {
          commandTemplate: selected.command,
          maxDiffSizeKb: config.maxDiffSizeKb,
        };

        const consumptionDeps: ConsumptionDeps = {
          client,
          agentId,
          limits: config.limits,
          session: createSessionTracker(),
        };

        console.log(`Starting agent ${selected.local.model} (${agentId})...`);
        startAgent(agentId, config.platformUrl, apiKey, reviewDeps, consumptionDeps, {
          verbose: opts.verbose,
          stabilityThresholdMs,
        });
        return;
      }

      // === Path A: Old server-side behavior (no agents section) ===
      console.log(
        'Hint: No agents in local config. Run `opencrust agent init` to import, or `opencrust agent create` to add agents.',
      );

      let agentId = agentIdOrModel;
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
        try {
          const res = await client.get<ListAgentsResponse>('/api/agents');
          const agent = res.agents.find((a) => a.id === agentId);
          if (agent) {
            agentTool = agent.tool;
          }
        } catch (err) {
          console.warn(
            `Warning: Failed to fetch agent info: ${err instanceof Error ? err.message : 'unknown error'}`,
          );
        }
      }

      let reviewDeps: ReviewExecutorDeps | undefined;
      try {
        const commandTemplate = resolveCommandTemplate(config.agentCommand);
        reviewDeps = {
          commandTemplate,
          maxDiffSizeKb: config.maxDiffSizeKb,
        };
      } catch (err) {
        console.warn(
          `Warning: ${err instanceof Error ? err.message : 'Could not determine agent command.'}` +
            ' Reviews will be rejected.',
        );
      }

      const consumptionDeps: ConsumptionDeps = {
        client,
        agentId,
        limits: config.limits,
        session: createSessionTracker(),
      };

      console.log(`Starting agent ${agentId}...`);
      startAgent(agentId, config.platformUrl, apiKey, reviewDeps, consumptionDeps, {
        verbose: opts.verbose,
        stabilityThresholdMs,
      });
    },
  );
