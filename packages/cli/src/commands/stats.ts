import { Command } from 'commander';
import type {
  ListAgentsResponse,
  AgentResponse,
  AgentStatsResponse,
  TrustTierInfo,
  RepoConfig,
} from '@opencara/shared';
import { loadConfig, requireApiKey } from '../config.js';
import { ApiClient } from '../http.js';

function formatTrustTier(tier: TrustTierInfo): string {
  const lines: string[] = [];
  const pctPositive = Math.round(tier.positiveRate * 100);
  lines.push(`  Trust:    ${tier.label} (${tier.reviewCount} reviews, ${pctPositive}% positive)`);
  if (tier.nextTier) {
    const pctProgress = Math.round(tier.progressToNext * 100);
    const nextLabel = tier.nextTier.charAt(0).toUpperCase() + tier.nextTier.slice(1);
    lines.push(`            Progress to ${nextLabel}: ${pctProgress}%`);
  }
  return lines.join('\n');
}

function formatReviewQuality(stats: AgentStatsResponse['stats']): string {
  const lines: string[] = [];
  lines.push(`  Reviews:  ${stats.totalReviews} completed, ${stats.totalSummaries} summaries`);
  const totalRatings = stats.thumbsUp + stats.thumbsDown;
  if (totalRatings > 0) {
    const pctPositive = Math.round((stats.thumbsUp / totalRatings) * 100);
    lines.push(`  Quality:  ${stats.thumbsUp}/${totalRatings} positive ratings (${pctPositive}%)`);
  } else {
    lines.push(`  Quality:  No ratings yet`);
  }
  return lines.join('\n');
}

function formatRepoConfig(repoConfig: RepoConfig | null): string {
  if (!repoConfig) return '  Repos:    all (default)';
  switch (repoConfig.mode) {
    case 'all':
      return '  Repos:    all';
    case 'own':
      return '  Repos:    own repos only';
    case 'whitelist':
      return `  Repos:    whitelist (${repoConfig.list?.join(', ') ?? 'none'})`;
    case 'blacklist':
      return `  Repos:    blacklist (${repoConfig.list?.join(', ') ?? 'none'})`;
    default:
      return `  Repos:    ${repoConfig.mode}`;
  }
}

function formatAgentStats(agent: AgentResponse, agentStats?: AgentStatsResponse | null): string {
  const lines: string[] = [];
  lines.push(`Agent: ${agent.id} (${agent.model} / ${agent.tool})`);
  lines.push(formatRepoConfig(agent.repoConfig));

  if (agentStats) {
    lines.push(formatTrustTier(agentStats.agent.trustTier));
    lines.push(formatReviewQuality(agentStats.stats));
  }

  return lines.join('\n');
}

export { formatAgentStats, formatTrustTier, formatReviewQuality, formatRepoConfig };

async function fetchAgentStats(
  client: ApiClient,
  agentId: string,
): Promise<AgentStatsResponse | null> {
  try {
    return await client.get<AgentStatsResponse>(`/api/stats/${agentId}`);
  } catch {
    return null;
  }
}

export const statsCommand = new Command('stats')
  .description('Display agent dashboard: trust tier and review quality')
  .option('--agent <agentId>', 'Show stats for a specific agent')
  .action(async (opts: { agent?: string }) => {
    const config = loadConfig();
    const apiKey = requireApiKey(config);
    const client = new ApiClient(config.platformUrl, apiKey);

    if (opts.agent) {
      // Create a minimal agent representation for display
      const agent: AgentResponse = {
        id: opts.agent,
        model: 'unknown',
        tool: 'unknown',
        isAnonymous: false,
        status: 'offline',
        repoConfig: null,
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

      const agentStats = await fetchAgentStats(client, opts.agent);
      console.log(formatAgentStats(agent, agentStats));
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
      console.log('No agents registered. Run `opencara agent create` to register one.');
      return;
    }

    const outputs: string[] = [];
    for (const agent of agentsRes.agents) {
      try {
        const agentStats = await fetchAgentStats(client, agent.id);
        outputs.push(formatAgentStats(agent, agentStats));
      } catch (err) {
        outputs.push(
          `Agent: ${agent.id} (${agent.model} / ${agent.tool})\n  Error: ${err instanceof Error ? err.message : 'Failed to fetch stats'}`,
        );
      }
    }

    console.log(outputs.join('\n\n'));
  });
