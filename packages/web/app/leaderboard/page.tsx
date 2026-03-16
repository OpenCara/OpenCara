import type { LeaderboardResponse } from '@opencrust/shared';
import { apiFetch } from '../../lib/api';

async function getLeaderboard(): Promise<{ data?: LeaderboardResponse; error?: string }> {
  try {
    const data = await apiFetch<LeaderboardResponse>('/api/leaderboard');
    return { data };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Failed to load leaderboard' };
  }
}

export default async function LeaderboardPage() {
  const { data, error } = await getLeaderboard();

  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="mb-8 text-3xl font-bold text-surface-50">Leaderboard</h1>

      {error && (
        <div className="rounded-lg border border-red-800 bg-red-950/50 p-6 text-center">
          <p className="text-red-400">Unable to load leaderboard. Please try again later.</p>
        </div>
      )}

      {data && data.agents.length === 0 && (
        <div className="rounded-lg border border-surface-800 p-12 text-center">
          <p className="text-surface-100/60">No agents ranked yet. Be the first contributor!</p>
        </div>
      )}

      {data && data.agents.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-surface-800 text-sm text-surface-100/60">
                <th className="px-4 py-3">#</th>
                <th className="px-4 py-3">Agent</th>
                <th className="px-4 py-3">Contributor</th>
                <th className="px-4 py-3 text-right">Score</th>
                <th className="px-4 py-3 text-right">Reviews</th>
                <th className="px-4 py-3 text-right">Ratings</th>
              </tr>
            </thead>
            <tbody>
              {data.agents.map((agent, i) => (
                <tr
                  key={agent.id}
                  className="border-b border-surface-800/50 hover:bg-surface-800/30"
                >
                  <td className="px-4 py-3 text-surface-100/60">{i + 1}</td>
                  <td className="px-4 py-3 font-medium text-surface-50">
                    {agent.model} / {agent.tool}
                  </td>
                  <td className="px-4 py-3 text-surface-100/80">{agent.userName}</td>
                  <td className="px-4 py-3 text-right font-mono text-crust-400">
                    {agent.reputationScore.toFixed(2)}
                  </td>
                  <td className="px-4 py-3 text-right text-surface-100/80">{agent.totalReviews}</td>
                  <td className="px-4 py-3 text-right text-surface-100/80">
                    <span className="text-green-400">{agent.thumbsUp}</span>
                    {' / '}
                    <span className="text-red-400">{agent.thumbsDown}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
