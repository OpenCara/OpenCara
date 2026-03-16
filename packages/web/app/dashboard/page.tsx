'use client';

import { useEffect, useState } from 'react';
import type {
  ListAgentsResponse,
  AgentResponse,
  AgentStatsResponse,
  ConsumptionStatsResponse,
} from '@opencrust/shared';
import { apiFetch } from '../../lib/api';
import { getSessionToken } from '../../lib/auth';

interface AgentCardData {
  agent: AgentResponse;
  stats: AgentStatsResponse['stats'] | null;
  consumption: ConsumptionStatsResponse['period'] | null;
  totalTokens: number | null;
  errors: string[];
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function AgentCardSkeleton() {
  return (
    <div className="animate-pulse rounded-lg border border-surface-800 p-6">
      <div className="mb-4 flex items-center justify-between">
        <div className="h-6 w-40 rounded bg-surface-800" />
        <div className="h-5 w-16 rounded-full bg-surface-800" />
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        <div className="h-20 rounded bg-surface-800" />
        <div className="h-20 rounded bg-surface-800" />
        <div className="h-20 rounded bg-surface-800" />
      </div>
    </div>
  );
}

function AgentCard({ data }: { data: AgentCardData }) {
  const { agent, stats, consumption, totalTokens, errors } = data;

  return (
    <div className="rounded-lg border border-surface-800 p-6">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-lg font-semibold text-surface-50">
          {agent.model} / {agent.tool}
        </h3>
        <span
          className={`rounded-full px-3 py-1 text-xs font-medium ${
            agent.status === 'online'
              ? 'bg-green-900/50 text-green-400'
              : 'bg-surface-800 text-surface-100/60'
          }`}
        >
          {agent.status}
        </span>
      </div>

      {errors.length > 0 && (
        <div className="mb-4 space-y-1">
          {errors.map((err, i) => (
            <p key={i} className="text-sm text-red-400">
              {err}
            </p>
          ))}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {/* Reputation */}
        <div className="rounded-md bg-surface-900 p-4">
          <p className="mb-1 text-xs text-surface-100/60">Reputation</p>
          <p className="text-2xl font-bold text-crust-400">{agent.reputationScore.toFixed(2)}</p>
          <div className="mt-2 h-2 w-full overflow-hidden rounded-full bg-surface-800">
            <div
              className="h-full rounded-full bg-crust-500"
              style={{ width: `${Math.min(agent.reputationScore * 100, 100)}%` }}
            />
          </div>
        </div>

        {/* Review Stats */}
        <div className="rounded-md bg-surface-900 p-4">
          <p className="mb-1 text-xs text-surface-100/60">Reviews</p>
          {stats ? (
            <>
              <p className="text-2xl font-bold text-surface-50">
                {formatNumber(stats.totalReviews)}
              </p>
              <div className="mt-1 text-xs text-surface-100/60">
                <span>{formatNumber(stats.totalSummaries)} summaries</span>
                <span className="mx-1">&middot;</span>
                <span>{formatNumber(stats.totalRatings)} ratings</span>
              </div>
              <div className="mt-1 text-xs">
                <span className="text-green-400">{formatNumber(stats.thumbsUp)}</span>
                <span className="text-surface-100/40"> / </span>
                <span className="text-red-400">{formatNumber(stats.thumbsDown)}</span>
              </div>
            </>
          ) : (
            <p className="text-sm text-surface-100/40">--</p>
          )}
        </div>

        {/* Consumption */}
        <div className="rounded-md bg-surface-900 p-4">
          <p className="mb-1 text-xs text-surface-100/60">Consumption</p>
          {consumption ? (
            <>
              <p className="text-2xl font-bold text-surface-50">{formatNumber(totalTokens ?? 0)}</p>
              <p className="mb-1 text-xs text-surface-100/40">total tokens</p>
              <div className="space-y-0.5 text-xs text-surface-100/60">
                <p>24h: {formatNumber(consumption.last24h.tokens)}</p>
                <p>7d: {formatNumber(consumption.last7d.tokens)}</p>
                <p>30d: {formatNumber(consumption.last30d.tokens)}</p>
              </div>
            </>
          ) : (
            <p className="text-sm text-surface-100/40">--</p>
          )}
        </div>
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const [agents, setAgents] = useState<AgentCardData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadDashboard() {
      const token = getSessionToken();
      const headers: Record<string, string> = {};
      if (token) {
        headers['Authorization'] = `Bearer ${token}`;
      }

      try {
        const { agents: agentList } = await apiFetch<ListAgentsResponse>('/api/agents', {
          headers,
          signal: controller.signal,
        });

        const cards = await Promise.all(
          agentList.map(async (agent) => {
            let stats: AgentStatsResponse['stats'] | null = null;
            let consumption: ConsumptionStatsResponse['period'] | null = null;
            let totalTokens: number | null = null;
            const errors: string[] = [];

            try {
              const statsRes = await apiFetch<AgentStatsResponse>(`/api/stats/${agent.id}`, {
                headers,
                signal: controller.signal,
              });
              stats = statsRes.stats;
            } catch {
              errors.push('Failed to load stats');
            }

            try {
              const consumptionRes = await apiFetch<ConsumptionStatsResponse>(
                `/api/consumption/${agent.id}`,
                { headers, signal: controller.signal },
              );
              consumption = consumptionRes.period;
              totalTokens = consumptionRes.totalTokens;
            } catch {
              errors.push('Failed to load consumption');
            }

            return { agent, stats, consumption, totalTokens, errors };
          }),
        );

        if (!controller.signal.aborted) {
          setAgents(cards);
        }
      } catch (e) {
        if (!controller.signal.aborted) {
          setError(e instanceof Error ? e.message : 'Failed to load agents');
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    loadDashboard();
    return () => controller.abort();
  }, []);

  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="mb-8 text-3xl font-bold text-surface-50">My Dashboard</h1>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 p-6 text-center">
          <p className="text-red-400">{error}</p>
        </div>
      )}

      {loading && (
        <div className="space-y-6">
          <AgentCardSkeleton />
          <AgentCardSkeleton />
        </div>
      )}

      {!loading && !error && agents.length === 0 && (
        <div className="rounded-lg border border-surface-800 p-12 text-center">
          <p className="text-lg text-surface-100/60">No agents registered.</p>
          <p className="mt-2 text-sm text-surface-100/40">
            Run <code className="rounded bg-surface-800 px-2 py-0.5">opencrust agent create</code>{' '}
            to get started.
          </p>
        </div>
      )}

      {!loading && !error && agents.length > 0 && (
        <div className="space-y-6">
          {agents.map((card) => (
            <AgentCard key={card.agent.id} data={card} />
          ))}
        </div>
      )}
    </div>
  );
}
