import type { ProjectStatsResponse } from '@opencrust/shared';
import { apiFetch } from '../../lib/api';

export const dynamic = 'force-dynamic';

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function formatPercent(n: number): string {
  return `${Math.round(n * 100)}%`;
}

function formatTimeAgo(dateString: string): string {
  const now = Date.now();
  const then = new Date(dateString).getTime();
  const diffMs = now - then;
  const diffMin = Math.floor(diffMs / 60_000);
  if (diffMin < 1) return 'just now';
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  return `${diffDay}d ago`;
}

async function fetchStats(): Promise<ProjectStatsResponse | null> {
  try {
    return await apiFetch<ProjectStatsResponse>('/api/projects/stats');
  } catch {
    return null;
  }
}

export default async function CommunityPage() {
  const stats = await fetchStats();

  if (!stats) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-12">
        <h1 className="mb-8 text-3xl font-bold text-surface-50">Community</h1>
        <div className="rounded-lg border border-surface-800 p-12 text-center">
          <p className="text-surface-100/60">
            Unable to load community stats. Please try again later.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-12">
      <h1 className="mb-8 text-3xl font-bold text-surface-50">Community</h1>

      {/* Stats grid */}
      <div className="mb-12 grid grid-cols-2 gap-6 lg:grid-cols-4">
        <div className="rounded-lg border border-surface-800 bg-surface-900/40 p-6 text-center">
          <div className="text-3xl font-extrabold text-crust-400">
            {formatNumber(stats.totalReviews)}
          </div>
          <div className="mt-1 text-sm text-surface-100/50">Reviews Completed</div>
        </div>
        <div className="rounded-lg border border-surface-800 bg-surface-900/40 p-6 text-center">
          <div className="text-3xl font-extrabold text-crust-400">
            {formatNumber(stats.totalContributors)}
          </div>
          <div className="mt-1 text-sm text-surface-100/50">Total Contributors</div>
        </div>
        <div className="rounded-lg border border-surface-800 bg-surface-900/40 p-6 text-center">
          <div className="text-3xl font-extrabold text-crust-400">
            {formatNumber(stats.activeContributorsThisWeek)}
          </div>
          <div className="mt-1 text-sm text-surface-100/50">Active This Week</div>
        </div>
        <div className="rounded-lg border border-surface-800 bg-surface-900/40 p-6 text-center">
          <div className="text-3xl font-extrabold text-crust-400">
            {formatPercent(stats.averagePositiveRate)}
          </div>
          <div className="mt-1 text-sm text-surface-100/50">Avg Review Quality</div>
        </div>
      </div>

      {/* Recent activity */}
      <h2 className="mb-4 text-xl font-semibold text-surface-50">Recent Activity</h2>
      {stats.recentActivity.length === 0 ? (
        <div className="rounded-lg border border-surface-800 p-8 text-center">
          <p className="text-surface-100/60">No recent activity yet.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {stats.recentActivity.map((entry, i) => (
            <div
              key={`${entry.repo}-${entry.prNumber}-${i}`}
              className="flex items-center justify-between rounded-lg border border-surface-800 bg-surface-900/40 px-5 py-3"
            >
              <div className="flex items-center gap-3">
                <span className="text-sm font-medium text-surface-50">{entry.repo}</span>
                <span className="text-sm text-surface-100/50">PR #{entry.prNumber}</span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-xs text-surface-100/40">{entry.agentModel}</span>
                <span className="text-xs text-surface-100/30">
                  {formatTimeAgo(entry.completedAt)}
                </span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
