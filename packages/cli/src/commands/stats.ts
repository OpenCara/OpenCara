import { Command } from 'commander';
import type {
  ConsumptionStatsResponse,
  ListAgentsResponse,
  AgentResponse,
} from '@opencrust/shared';
import { loadConfig, requireApiKey, type ConsumptionLimits } from '../config.js';
import { ApiClient } from '../http.js';
import { fetchConsumptionStats } from '../consumption.js';

function formatAgentStats(
  agent: AgentResponse,
  stats: ConsumptionStatsResponse,
  limits?: ConsumptionLimits | null,
): string {
  const lines: string[] = [];
  lines.push(`Agent: ${agent.id} (${agent.model} / ${agent.tool})`);
  lines.push(
    `  Total: ${stats.totalTokens.toLocaleString()} tokens across ${stats.totalReviews} reviews`,
  );
  lines.push(
    `  Last 24h: ${stats.period.last24h.tokens.toLocaleString()} tokens / ${stats.period.last24h.reviews} reviews`,
  );
  lines.push(
    `  Last 7d:  ${stats.period.last7d.tokens.toLocaleString()} tokens / ${stats.period.last7d.reviews} reviews`,
  );
  lines.push(
    `  Last 30d: ${stats.period.last30d.tokens.toLocaleString()} tokens / ${stats.period.last30d.reviews} reviews`,
  );

  if (limits?.tokens_per_day) {
    const remaining = Math.max(0, limits.tokens_per_day - stats.period.last24h.tokens);
    lines.push(
      `  Budget:   ${stats.period.last24h.tokens.toLocaleString()} / ${limits.tokens_per_day.toLocaleString()} tokens (24h) — ${remaining.toLocaleString()} remaining`,
    );
  } else if (limits?.tokens_per_month) {
    const remaining = Math.max(0, limits.tokens_per_month - stats.period.last30d.tokens);
    lines.push(
      `  Budget:   ${stats.period.last30d.tokens.toLocaleString()} / ${limits.tokens_per_month.toLocaleString()} tokens (30d) — ${remaining.toLocaleString()} remaining`,
    );
  }

  return lines.join('\n');
}

export { formatAgentStats };

export const statsCommand = new Command('stats')
  .description('Display consumption statistics for agents')
  .option('--agent <agentId>', 'Show stats for a specific agent')
  .action(async (opts: { agent?: string }) => {
    const config = loadConfig();
    const apiKey = requireApiKey(config);
    const client = new ApiClient(config.platformUrl, apiKey);

    if (opts.agent) {
      let stats: ConsumptionStatsResponse;
      try {
        stats = await fetchConsumptionStats(client, opts.agent);
      } catch (err) {
        console.error(
          'Failed to fetch consumption stats:',
          err instanceof Error ? err.message : err,
        );
        process.exit(1);
      }

      // Create a minimal agent representation for display
      const agent: AgentResponse = {
        id: opts.agent,
        model: 'unknown',
        tool: 'unknown',
        status: 'offline',
        createdAt: '',
      };

      // Try to fetch agent details for better display
      try {
        const agentsRes = await client.get<ListAgentsResponse>('/api/agents');
        const found = agentsRes.agents.find((a) => a.id === opts.agent);
        if (found) {
          agent.model = found.model;
          agent.tool = found.tool;
        }
      } catch {
        // Proceed with unknown model/tool
      }

      console.log(formatAgentStats(agent, stats, config.limits));
      return;
    }

    // Show stats for all agents
    let agentsRes: ListAgentsResponse;
    try {
      agentsRes = await client.get<ListAgentsResponse>('/api/agents');
    } catch (err) {
      console.error('Failed to list agents:', err instanceof Error ? err.message : err);
      process.exit(1);
    }

    if (agentsRes.agents.length === 0) {
      console.log('No agents registered. Run `opencrust agent create` to register one.');
      return;
    }

    const outputs: string[] = [];
    for (const agent of agentsRes.agents) {
      try {
        const stats = await fetchConsumptionStats(client, agent.id);
        outputs.push(formatAgentStats(agent, stats, config.limits));
      } catch (err) {
        outputs.push(
          `Agent: ${agent.id} (${agent.model} / ${agent.tool})\n  Error: ${err instanceof Error ? err.message : 'Failed to fetch stats'}`,
        );
      }
    }

    console.log(outputs.join('\n\n'));
  });
